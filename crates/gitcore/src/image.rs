//! The two sides of an image file for the image diff (bytes as base64, with a size cap).

use std::io::Read;
use std::path::Path;

use crate::diff::{first_parent_or_empty, worktree_path};
use crate::error::{check_name, GitError};
use crate::model::*;
use crate::runner::Git;

/// A side bigger than this many bytes is reported by size only (`ImageSide::too_large`).
pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// MIME type of an image file name, from its extension. `None` when it is not a known image.
pub fn image_mime(path: &str) -> Option<&'static str> {
    let ext = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => return None,
    })
}

/// Standard base64 (RFC 4648, with padding).
pub fn base64_encode(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(ABC[(n >> 18) as usize & 63] as char);
        out.push(ABC[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ABC[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ABC[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn side(path: &str, size: u64, bytes: Option<Vec<u8>>) -> ImageSide {
    ImageSide {
        size,
        mime: image_mime(path)
            .unwrap_or("application/octet-stream")
            .to_string(),
        data: bytes.as_deref().map(base64_encode),
        too_large: bytes.is_none(),
    }
}

/// A path that git stores must be plain: no `..`, no root. It is part of a `rev:path` argument.
fn check_plain(path: &str) -> Result<(), GitError> {
    if path.is_empty()
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(GitError::Invalid(format!("bad path: {path}")));
    }
    Ok(())
}

/// The object id that `object` names (`<rev>:<path>` or `:<stage>:<path>` for the index). `None`
/// when it does not exist. Read the size and the bytes by this id: a name can point to another
/// blob a moment later, an id cannot.
fn resolve_object(git: &Git, repo: &RepoInfo, object: &str) -> Result<Option<String>, GitError> {
    let out = git.run_unchecked(
        Path::new(&repo.path),
        Some(&repo.id),
        &["rev-parse", "--verify", "--quiet", object],
        false,
        None,
    )?;
    let id = out.stdout.trim();
    if out.code != 0 || id.is_empty() {
        return Ok(None);
    }
    Ok(Some(id.to_string()))
}

/// The blob `object` names (see [`resolve_object`]). `None` when it does not exist. The name is
/// resolved once, and the size check and the read both use that id, so the cap holds.
fn read_object(
    git: &Git,
    repo: &RepoInfo,
    object: &str,
    path: &str,
) -> Result<Option<ImageSide>, GitError> {
    match resolve_object(git, repo, object)? {
        Some(id) => read_blob(git, repo, &id, path),
        None => Ok(None),
    }
}

/// The blob with the object id `id`. `None` when it is not there or is not a blob.
fn read_blob(
    git: &Git,
    repo: &RepoInfo,
    id: &str,
    path: &str,
) -> Result<Option<ImageSide>, GitError> {
    let rp = Path::new(&repo.path);
    let size = git.run_unchecked(rp, Some(&repo.id), &["cat-file", "-s", id], false, None)?;
    if size.code != 0 {
        return Ok(None);
    }
    let Ok(size) = size.stdout.trim().parse::<u64>() else {
        return Ok(None);
    };
    if size > MAX_IMAGE_BYTES {
        return Ok(Some(side(path, size, None)));
    }
    let out = git.run_unchecked_raw(rp, Some(&repo.id), &["cat-file", "blob", id], false, None)?;
    if out.code != 0 {
        return Ok(None);
    }
    Ok(Some(side(path, out.stdout.len() as u64, Some(out.stdout))))
}

/// The old side of the unstaged diff: the index entry of `path`. A conflicted path has no entry
/// at stage 0, so the old side is "ours" (stage 2), else "theirs" (stage 3), else HEAD (both
/// sides deleted it). A path with no entry and no conflict has no old side.
fn read_index_side(git: &Git, repo: &RepoInfo, path: &str) -> Result<Option<ImageSide>, GitError> {
    if let Some(id) = resolve_object(git, repo, &format!(":0:{path}"))? {
        return read_blob(git, repo, &id, path);
    }
    for stage in [2, 3] {
        if let Some(id) = resolve_object(git, repo, &format!(":{stage}:{path}"))? {
            return read_blob(git, repo, &id, path);
        }
    }
    // Stage 1 only: both sides deleted the file. Only a conflicted path gets the HEAD fallback.
    if resolve_object(git, repo, &format!(":1:{path}"))?.is_some() {
        return read_object(git, repo, &format!("HEAD:{path}"), path);
    }
    Ok(None)
}

/// The regular file `path` of the worktree. `None` when missing, a symlink or not a file.
fn read_worktree(repo: &RepoInfo, path: &str) -> Result<Option<ImageSide>, GitError> {
    let full = worktree_path(repo, path)?;
    let Ok(meta) = std::fs::symlink_metadata(&full) else {
        return Ok(None);
    };
    if !meta.file_type().is_file() {
        return Ok(None);
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Ok(Some(side(path, meta.len(), None)));
    }
    let mut buf = Vec::new();
    std::fs::File::open(&full)?
        .take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut buf)?;
    if buf.len() as u64 > MAX_IMAGE_BYTES {
        return Ok(Some(side(path, buf.len() as u64, None)));
    }
    Ok(Some(side(path, buf.len() as u64, Some(buf))))
}

/// The two sides of an image for a commit (parent -> commit), the index (HEAD -> index) or the
/// worktree (index -> worktree), the same sides `file_diff` compares. The old side is read at
/// `old_path` when the file was renamed.
pub fn file_images(
    git: &Git,
    repo: &RepoInfo,
    spec: &DiffSpec,
    path: &str,
    old_path: Option<&str>,
) -> Result<FileImages, GitError> {
    check_plain(path)?;
    let old_name = old_path.filter(|o| !o.is_empty()).unwrap_or(path);
    check_plain(old_name)?;
    match spec {
        DiffSpec::Commit { oid, parent } => {
            check_name("commit", oid)?;
            let parent = match parent {
                Some(p) => {
                    check_name("parent commit", p)?;
                    p.clone()
                }
                None => first_parent_or_empty(git, repo, oid)?,
            };
            Ok(FileImages {
                old: read_object(git, repo, &format!("{parent}:{old_name}"), old_name)?,
                new: read_object(git, repo, &format!("{oid}:{path}"), path)?,
            })
        }
        DiffSpec::Staged => Ok(FileImages {
            old: read_object(git, repo, &format!("HEAD:{old_name}"), old_name)?,
            new: read_object(git, repo, &format!(":0:{path}"), path)?,
        }),
        DiffSpec::Unstaged => Ok(FileImages {
            old: read_index_side(git, repo, path)?,
            new: read_worktree(repo, path)?,
        }),
    }
}
