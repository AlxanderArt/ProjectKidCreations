#!/usr/bin/env python3
import ctypes
import hashlib
import json
import os
import pwd
import re
import socket
import stat
import subprocess
import sys
from datetime import datetime, timezone
from typing import NoReturn

PRODUCTION_ROOT = "/Users/aiel/Desktop/PROJECTKIDCREATIONS/recovery/exports/vps-onboarding-postgres"
ARTIFACT_RE = re.compile(r"^pkc-onboarding-[0-9]{8}T[0-9]{6}Z\.dump\.age$")
HEX64_RE = re.compile(r"^[a-f0-9]{64}$")
NONCE_RE = re.compile(r"^[a-f0-9]{32}$")
TEST_ROOT_RE = re.compile(r"^/tmp/pkc-a1of1-remote-test-[A-Za-z0-9._-]+$")
FLAGS_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FLAGS_FILE = os.O_RDONLY | os.O_NOFOLLOW


def fail() -> NoReturn:
    raise RuntimeError("a1of1_publish_rejected")


def mode_bits(st):
    return stat.S_IMODE(st.st_mode)


def require_dir_fd(fd, uid, mode=0o700):
    st = os.fstat(fd)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != uid or mode_bits(st) != mode:
        fail()
    return st


def require_file_fd(fd, uid, expected_links=(1,), maximum=None):
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != uid or mode_bits(st) != 0o600 or st.st_nlink not in expected_links:
        fail()
    if st.st_size < 1 or (maximum is not None and st.st_size > maximum):
        fail()
    return st


def read_fd(fd, limit):
    st = require_file_fd(fd, os.geteuid(), (1, 2), limit)
    chunks, total, position = [], 0, 0
    while position < st.st_size:
        chunk = os.pread(fd, min(1024 * 1024, st.st_size - position), position)
        if not chunk:
            fail()
        chunks.append(chunk)
        total += len(chunk)
        position += len(chunk)
        if total > limit:
            fail()
    if total != st.st_size:
        fail()
    return b"".join(chunks)


def hash_fd(fd):
    st = os.fstat(fd)
    digest, position = hashlib.sha256(), 0
    while position < st.st_size:
        chunk = os.pread(fd, min(1024 * 1024, st.st_size - position), position)
        if not chunk:
            fail()
        digest.update(chunk)
        position += len(chunk)
    if position != st.st_size:
        fail()
    return digest.hexdigest()


def open_chain(root):
    fds, records = [], []
    current = os.open("/", FLAGS_DIR)
    fds.append(current)
    records.append((current, os.fstat(current), None, None))
    for component in [part for part in root.split("/") if part]:
        child = os.open(component, FLAGS_DIR, dir_fd=current)
        fds.append(child)
        child_stat = os.fstat(child)
        entry_stat = os.stat(component, dir_fd=current, follow_symlinks=False)
        if (child_stat.st_dev, child_stat.st_ino) != (entry_stat.st_dev, entry_stat.st_ino):
            fail()
        records.append((child, child_stat, current, component))
        current = child
    return fds, records, current


def revalidate_chain(records):
    for fd, original, parent_fd, name in records:
        current = os.fstat(fd)
        if (current.st_dev, current.st_ino, current.st_mode, current.st_uid, current.st_nlink) != (original.st_dev, original.st_ino, original.st_mode, original.st_uid, original.st_nlink):
            fail()
        if parent_fd is not None:
            entry = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            if (entry.st_dev, entry.st_ino, entry.st_mode, entry.st_uid) != (current.st_dev, current.st_ino, current.st_mode, current.st_uid):
                fail()


def identity_digest(values):
    return hashlib.sha256(json.dumps(values, separators=(",", ":"), sort_keys=True).encode()).hexdigest()


def layout_proof(records, layout):
    values = []
    for index, (fd, _original, _parent_fd, name) in enumerate(records):
        st = os.fstat(fd)
        values.append([name or "/", st.st_dev, st.st_ino, st.st_mode, st.st_uid] + ([st.st_ctime_ns] if index == len(records) - 1 else []))
    for name in sorted(layout):
        st = os.fstat(layout[name])
        values.append([name, st.st_dev, st.st_ino, st.st_mode, st.st_uid])
    return identity_digest(values)


def stage_proof(stage_fd, staging_fd):
    st = os.fstat(stage_fd)
    parent = os.fstat(staging_fd)
    return identity_digest([["stage", st.st_dev, st.st_ino, st.st_mode, st.st_uid], ["staging-parent", parent.st_dev, parent.st_ino, parent.st_mode, parent.st_uid, parent.st_ctime_ns]])


def require_layout_proof(expected_layout, records, layout):
    if not HEX64_RE.fullmatch(expected_layout) or layout_proof(records, layout) != expected_layout:
        fail()


def require_authority_tokens(expected_layout, expected_stage, records, layout, stage_fd, staging_fd):
    require_layout_proof(expected_layout, records, layout)
    if not HEX64_RE.fullmatch(expected_stage) or stage_proof(stage_fd, staging_fd) != expected_stage:
        fail()


def open_layout(root, owner):
    uid = pwd.getpwnam(owner).pw_uid
    test_mode = os.environ.get("PKC_A1OF1_REMOTE_TEST_MODE") == "1" and owner != "aiel" and TEST_ROOT_RE.fullmatch(root)
    if not ((root == PRODUCTION_ROOT and owner == "aiel") or test_mode):
        fail()
    if uid != os.geteuid():
        fail()
    fds, records, root_fd = open_chain(root)
    root_st = require_dir_fd(root_fd, uid)
    children = {}
    for name in ("staging", "bundles", "receipts"):
        fd = os.open(name, FLAGS_DIR, dir_fd=root_fd)
        st = require_dir_fd(fd, uid)
        if st.st_dev != root_st.st_dev:
            fail()
        fds.append(fd)
        children[name] = fd
    revalidate_chain(records)
    return uid, fds, records, root_fd, children


def open_stage(staging_fd, nonce, uid):
    entry = os.stat(nonce, dir_fd=staging_fd, follow_symlinks=False)
    fd = os.open(nonce, FLAGS_DIR, dir_fd=staging_fd)
    st = require_dir_fd(fd, uid)
    if (entry.st_dev, entry.st_ino) != (st.st_dev, st.st_ino):
        fail()
    marker_fd = os.open(".owner", FLAGS_FILE, dir_fd=fd)
    try:
        require_file_fd(marker_fd, uid, (1,), 128)
        if read_fd(marker_fd, 128) != (nonce + "\n").encode():
            fail()
    finally:
        os.close(marker_fd)
    return fd, st


def exact_entries(fd, expected):
    actual = set(os.listdir(fd))
    if actual != set(expected):
        fail()


def remove_receipt_temp(receipts_fd, nonce, uid):
    name = f".{nonce}.custody.tmp"
    try:
        st = os.stat(name, dir_fd=receipts_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    fd = os.open(name, FLAGS_FILE, dir_fd=receipts_fd)
    try:
        current = require_file_fd(fd, uid, (1,), 4096)
        if (st.st_dev, st.st_ino) != (current.st_dev, current.st_ino):
            fail()
    finally:
        os.close(fd)
    os.unlink(name, dir_fd=receipts_fd)
    os.fsync(receipts_fd)


def cleanup_stage(staging_fd, receipts_fd, nonce, uid):
    remove_receipt_temp(receipts_fd, nonce, uid)
    try:
        entry = os.stat(nonce, dir_fd=staging_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(entry.st_mode):
        fail()
    stage_fd, opened = open_stage(staging_fd, nonce, uid)
    try:
        entries = set(os.listdir(stage_fd))
        allowed = {".owner", "artifact", "checksum", "backup-receipt", "source-receipt"}
        if ".owner" not in entries or not entries.issubset(allowed):
            fail()
        for name in ("artifact", "checksum", "backup-receipt", "source-receipt", ".owner"):
            try:
                child = os.stat(name, dir_fd=stage_fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(child.st_mode) or child.st_uid != uid:
                fail()
            os.unlink(name, dir_fd=stage_fd)
        exact_entries(stage_fd, set())
        os.fsync(stage_fd)
        current_entry = os.stat(nonce, dir_fd=staging_fd, follow_symlinks=False)
        current_open = os.fstat(stage_fd)
        if (current_entry.st_dev, current_entry.st_ino) != (opened.st_dev, opened.st_ino) or (current_open.st_dev, current_open.st_ino) != (opened.st_dev, opened.st_ino):
            fail()
    finally:
        os.close(stage_fd)
    os.rmdir(nonce, dir_fd=staging_fd)
    os.fsync(staging_fd)
    try:
        os.stat(nonce, dir_fd=staging_fd, follow_symlinks=False)
        fail()
    except FileNotFoundError:
        pass


def validate_identity(artifact, artifact_sha, nonce):
    if not ARTIFACT_RE.fullmatch(artifact) or not HEX64_RE.fullmatch(artifact_sha) or not NONCE_RE.fullmatch(nonce):
        fail()


def open_final_file(dir_fd, name, uid, expected_sha, maximum, links=(1, 2)):
    entry = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    fd = os.open(name, FLAGS_FILE, dir_fd=dir_fd)
    current = require_file_fd(fd, uid, links, maximum)
    if (entry.st_dev, entry.st_ino) != (current.st_dev, current.st_ino) or hash_fd(fd) != expected_sha:
        os.close(fd)
        fail()
    return fd


def verify_bundle_fd(bundle_fd, receipts_fd, root, owner, layout_identity, artifact, artifact_sha, checksum_sha, backup_receipt_sha, source_receipt_sha, uid, final_links=(1, 2)):
    require_dir_fd(bundle_fd, uid)
    exact_entries(bundle_fd, {artifact, artifact + ".sha256"})
    artifact_fd = open_final_file(bundle_fd, artifact, uid, artifact_sha, 64 * 1024**3, final_links)
    checksum_fd = open_final_file(bundle_fd, artifact + ".sha256", uid, checksum_sha, 256, final_links)
    backup_receipt_fd = open_final_file(receipts_fd, artifact_sha + ".backup-receipt.json", uid, backup_receipt_sha, 4096, final_links)
    source_receipt_fd = open_final_file(receipts_fd, artifact_sha + ".source-receipt.json", uid, source_receipt_sha, 16384, final_links)
    custody_fd = os.open(artifact_sha + ".custody-receipt.json", FLAGS_FILE, dir_fd=receipts_fd)
    try:
        require_file_fd(custody_fd, uid, final_links, 4096)
        if read_fd(checksum_fd, 256) != f"{artifact_sha}  {artifact}\n".encode(): fail()
        validate_custody_bytes(read_fd(custody_fd, 4096), root, owner, artifact, artifact_sha, checksum_sha, backup_receipt_sha, source_receipt_sha, layout_identity)
    finally:
        os.close(artifact_fd); os.close(checksum_fd); os.close(backup_receipt_fd); os.close(source_receipt_fd); os.close(custody_fd)


def open_bound_bundle(bundles_fd, artifact_sha, uid):
    entry = os.stat(artifact_sha, dir_fd=bundles_fd, follow_symlinks=False)
    bundle_fd = os.open(artifact_sha, FLAGS_DIR, dir_fd=bundles_fd)
    current = require_dir_fd(bundle_fd, uid)
    if (entry.st_dev, entry.st_ino) != (current.st_dev, current.st_ino):
        os.close(bundle_fd)
        fail()
    return bundle_fd, current


def revalidate_bound_entry(parent_fd, name, fd, original):
    current = os.fstat(fd)
    entry = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if (current.st_dev, current.st_ino, current.st_mode, current.st_uid) != (original.st_dev, original.st_ino, original.st_mode, original.st_uid):
        fail()
    if (entry.st_dev, entry.st_ino, entry.st_mode, entry.st_uid) != (current.st_dev, current.st_ino, current.st_mode, current.st_uid):
        fail()


def build_custody_receipt(root, owner, artifact, artifact_sha, checksum_sha, backup_receipt_sha, source_receipt_sha, layout_identity):
    value = {
        "artifact": artifact,
        "artifactSha256": artifact_sha,
        "backupReceiptSha256": backup_receipt_sha,
        "bundlePath": f"{root}/bundles/{artifact_sha}",
        "checksumSha256": checksum_sha,
        "destinationRoot": root,
        "layoutProof": layout_identity,
        "publishedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "remoteHostAlias": "a1of1",
        "remoteHostname": socket.gethostname(),
        "remotePlatform": "Darwin" if sys.platform == "darwin" else "test-only",
        "remoteUser": owner,
        "schema": "pkc-a1of1-custody-receipt-v1",
        "sourceReceiptSha256": source_receipt_sha,
    }
    return (json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n").encode()


def validate_custody_bytes(value, root, owner, artifact, artifact_sha, checksum_sha, backup_receipt_sha, source_receipt_sha, layout_identity):
    parsed = None
    try:
        parsed = json.loads(value.decode())
    except Exception:
        fail()
    if not isinstance(parsed, dict): fail()
    expected_keys = {"artifact","artifactSha256","backupReceiptSha256","bundlePath","checksumSha256","destinationRoot","layoutProof","publishedAt","remoteHostAlias","remoteHostname","remotePlatform","remoteUser","schema","sourceReceiptSha256"}
    if set(parsed) != expected_keys: fail()
    expected = {
        "artifact": artifact, "artifactSha256": artifact_sha, "backupReceiptSha256": backup_receipt_sha,
        "bundlePath": f"{root}/bundles/{artifact_sha}", "checksumSha256": checksum_sha,
        "destinationRoot": root, "layoutProof": layout_identity, "remoteHostAlias": "a1of1",
        "remotePlatform": "Darwin" if sys.platform == "darwin" else "test-only", "remoteUser": owner,
        "schema": "pkc-a1of1-custody-receipt-v1", "sourceReceiptSha256": source_receipt_sha,
    }
    if any(parsed[key] != expected_value for key, expected_value in expected.items()): fail()
    if not isinstance(parsed["remoteHostname"], str) or not parsed["remoteHostname"] or len(parsed["remoteHostname"]) > 255: fail()
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", parsed["publishedAt"]): fail()
    return parsed


def publish_receipt_no_replace(receipts_fd, temp_fd, temp_name, receipt_name):
    try:
        if os.environ.get("PKC_A1OF1_REMOTE_TEST_MODE") == "1" and os.environ.get("PKC_A1OF1_REMOTE_TEST_FAIL_BEFORE_COMMIT") == "1": fail()
        libc = ctypes.CDLL(None, use_errno=True)
        if sys.platform == "darwin":
            os.unlink(temp_name, dir_fd=receipts_fd)
            os.fsync(receipts_fd)
            try:
                os.stat(temp_name, dir_fd=receipts_fd, follow_symlinks=False)
                fail()
            except FileNotFoundError:
                pass
            fclonefileat = libc.fclonefileat
            fclonefileat.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
            fclonefileat.restype = ctypes.c_int
            rc = fclonefileat(temp_fd, receipts_fd, receipt_name.encode(), 0)
        elif os.environ.get("PKC_A1OF1_REMOTE_TEST_MODE") == "1" and sys.platform.startswith("linux"):
            linkat = libc.linkat
            linkat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
            linkat.restype = ctypes.c_int
            rc = linkat(temp_fd, b"", receipts_fd, receipt_name.encode(), 0x1000)
            if rc == 0:
                os.unlink(temp_name, dir_fd=receipts_fd)
        else:
            fail()
        if rc != 0:
            fail()
        os.fsync(receipts_fd)
    finally:
        os.close(temp_fd)


def main():
    if len(sys.argv) < 7:
        fail()
    mode, root, owner, artifact, artifact_sha, nonce = sys.argv[1:7]
    validate_identity(artifact, artifact_sha, nonce)
    uid, fds, records, _root_fd, layout = open_layout(root, owner)
    try:
        staging_fd, bundles_fd, receipts_fd = layout["staging"], layout["bundles"], layout["receipts"]
        if mode == "preflight":
            if len(sys.argv) != 8 or not sys.argv[7].isdigit() or int(sys.argv[7]) < 1:
                fail()
            if sys.platform != "darwin" and os.environ.get("PKC_A1OF1_REMOTE_TEST_MODE") != "1":
                fail()
            if sys.platform == "darwin":
                result = subprocess.run(["/usr/bin/fdesetup", "status"], check=True, capture_output=True, text=True, timeout=10)
                if result.stdout.strip() != "FileVault is On.":
                    fail()
            free = os.fstatvfs(_root_fd).f_bavail * os.fstatvfs(_root_fd).f_frsize
            if free < int(sys.argv[7]) + 1024**3:
                fail()
            try:
                os.stat(nonce, dir_fd=staging_fd, follow_symlinks=False)
                fail()
            except FileNotFoundError:
                pass
            os.mkdir(nonce, 0o700, dir_fd=staging_fd)
            stage_fd = os.open(nonce, FLAGS_DIR, dir_fd=staging_fd)
            try:
                require_dir_fd(stage_fd, uid)
                marker_fd = os.open(".owner", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=stage_fd)
                try:
                    os.write(marker_fd, (nonce + "\n").encode()); os.fsync(marker_fd)
                finally:
                    os.close(marker_fd)
                issued_layout_proof = layout_proof(records, layout)
                issued_stage_proof = stage_proof(stage_fd, staging_fd)
            finally:
                os.close(stage_fd)
            revalidate_chain(records)
            print(f"a1of1_staging_ready=true\nlayout_proof={issued_layout_proof}\nstage_proof={issued_stage_proof}")
        elif mode == "receive":
            if len(sys.argv) != 11 or sys.argv[9] not in {"artifact", "checksum", "backup-receipt", "source-receipt"} or not HEX64_RE.fullmatch(sys.argv[10]):
                fail()
            expected_layout, expected_stage, name, expected_sha = sys.argv[7:11]
            stage_fd, _ = open_stage(staging_fd, nonce, uid)
            try:
                require_authority_tokens(expected_layout, expected_stage, records, layout, stage_fd, staging_fd)
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=stage_fd)
                digest = hashlib.sha256()
                try:
                    while True:
                        chunk = sys.stdin.buffer.read(1024 * 1024)
                        if not chunk: break
                        digest.update(chunk)
                        view = memoryview(chunk)
                        while view:
                            written = os.write(fd, view); view = view[written:]
                    os.fsync(fd)
                finally:
                    os.close(fd)
                check_fd = os.open(name, FLAGS_FILE, dir_fd=stage_fd)
                try:
                    require_file_fd(check_fd, uid, (1,), {"artifact":64*1024**3,"checksum":256,"backup-receipt":4096,"source-receipt":16384}[name])
                    if digest.hexdigest() != expected_sha or hash_fd(check_fd) != expected_sha:
                        fail()
                finally:
                    os.close(check_fd)
                require_authority_tokens(expected_layout, expected_stage, records, layout, stage_fd, staging_fd)
            except Exception:
                try: os.unlink(name, dir_fd=stage_fd)
                except Exception: pass
                raise
            finally:
                os.close(stage_fd)
            revalidate_chain(records)
            print(f"a1of1_received={name}")
        elif mode == "cleanup":
            if len(sys.argv) != 9: fail()
            expected_layout, expected_stage = sys.argv[7:9]
            require_layout_proof(expected_layout, records, layout)
            if not HEX64_RE.fullmatch(expected_stage): fail()
            try:
                cleanup_stage_fd, _ = open_stage(staging_fd, nonce, uid)
            except FileNotFoundError:
                cleanup_stage_fd = None
            if cleanup_stage_fd is not None:
                try:
                    require_authority_tokens(expected_layout, expected_stage, records, layout, cleanup_stage_fd, staging_fd)
                finally:
                    os.close(cleanup_stage_fd)
            cleanup_stage(staging_fd, receipts_fd, nonce, uid)
            revalidate_chain(records)
            require_layout_proof(expected_layout, records, layout)
            print("a1of1_staging_removed=true")
        elif mode == "finalize":
            if len(sys.argv) != 12 or not all(HEX64_RE.fullmatch(value) for value in sys.argv[7:12]): fail()
            expected_layout, expected_stage, checksum_sha, backup_receipt_sha, source_receipt_sha = sys.argv[7:12]
            stage_fd, _ = open_stage(staging_fd, nonce, uid)
            try:
                require_authority_tokens(expected_layout, expected_stage, records, layout, stage_fd, staging_fd)
                exact_entries(stage_fd, {".owner", "artifact", "checksum", "backup-receipt", "source-receipt"})
                artifact_fd = open_final_file(stage_fd, "artifact", uid, artifact_sha, 64*1024**3, (1,))
                checksum_fd = open_final_file(stage_fd, "checksum", uid, checksum_sha, 256, (1,))
                receipt_fd = open_final_file(stage_fd, "backup-receipt", uid, backup_receipt_sha, 4096, (1,))
                source_receipt_fd = open_final_file(stage_fd, "source-receipt", uid, source_receipt_sha, 16384, (1,))
                try:
                    checksum_bytes = read_fd(checksum_fd, 256)
                    receipt_bytes = read_fd(receipt_fd, 4096)
                    if checksum_bytes != f"{artifact_sha}  {artifact}\n".encode(): fail()
                finally:
                    os.close(artifact_fd); os.close(checksum_fd); os.close(receipt_fd); os.close(source_receipt_fd)
                require_authority_tokens(expected_layout, expected_stage, records, layout, stage_fd, staging_fd)
            finally:
                os.close(stage_fd)
            custody_name = artifact_sha + ".custody-receipt.json"
            backup_receipt_name = artifact_sha + ".backup-receipt.json"
            source_receipt_name = artifact_sha + ".source-receipt.json"
            try:
                os.stat(custody_name, dir_fd=receipts_fd, follow_symlinks=False)
                receipt_exists = True
            except FileNotFoundError:
                receipt_exists = False
            if receipt_exists:
                bundle_fd, bundle_identity = open_bound_bundle(bundles_fd, artifact_sha, uid)
                try:
                    verify_bundle_fd(bundle_fd, receipts_fd, root, owner, expected_layout, artifact, artifact_sha, checksum_sha, backup_receipt_sha, source_receipt_sha, uid, (1,))
                    cleanup_stage(staging_fd, receipts_fd, nonce, uid)
                    verify_bundle_fd(bundle_fd, receipts_fd, root, owner, expected_layout, artifact, artifact_sha, checksum_sha, backup_receipt_sha, source_receipt_sha, uid, (1,))
                    revalidate_bound_entry(bundles_fd, artifact_sha, bundle_fd, bundle_identity)
                finally:
                    os.close(bundle_fd)
                revalidate_chain(records)
                require_layout_proof(expected_layout, records, layout)
                print(f"a1of1_backup_published=true\na1of1_idempotent=true\nartifact_sha256={artifact_sha}")
                return
            try:
                os.mkdir(artifact_sha, 0o700, dir_fd=bundles_fd)
            except FileExistsError:
                pass
            bundle_fd, bundle_identity = open_bound_bundle(bundles_fd, artifact_sha, uid)
            try:
                stage_fd, _ = open_stage(staging_fd, nonce, uid)
                try:
                    for source, destination, expected in (("artifact", artifact, artifact_sha), ("checksum", artifact + ".sha256", checksum_sha)):
                        try:
                            os.link(source, destination, src_dir_fd=stage_fd, dst_dir_fd=bundle_fd, follow_symlinks=False)
                        except FileExistsError:
                            pass
                        fd = open_final_file(bundle_fd, destination, uid, expected, 64*1024**3 if source == "artifact" else 256, (1,2))
                        os.close(fd)
                    for source_name, final_name, expected_hash, maximum in (("backup-receipt", backup_receipt_name, backup_receipt_sha, 4096), ("source-receipt", source_receipt_name, source_receipt_sha, 16384)):
                        try:
                            os.link(source_name, final_name, src_dir_fd=stage_fd, dst_dir_fd=receipts_fd, follow_symlinks=False)
                        except FileExistsError:
                            pass
                        final_fd = open_final_file(receipts_fd, final_name, uid, expected_hash, maximum, (1,2))
                        os.close(final_fd)
                finally:
                    os.close(stage_fd)
                exact_entries(bundle_fd, {artifact, artifact + ".sha256"})
                cleanup_stage(staging_fd, receipts_fd, nonce, uid)
                # Final data links are singular and the bound bundle is stable before the receipt marker exists.
                exact_entries(bundle_fd, {artifact, artifact + ".sha256"})
                for name, expected, maximum in ((artifact, artifact_sha, 64*1024**3), (artifact + ".sha256", checksum_sha, 256)):
                    fd = open_final_file(bundle_fd, name, uid, expected, maximum, (1,)); os.close(fd)
                backup_final_fd = open_final_file(receipts_fd, backup_receipt_name, uid, backup_receipt_sha, 4096, (1,)); os.close(backup_final_fd)
                source_final_fd = open_final_file(receipts_fd, source_receipt_name, uid, source_receipt_sha, 16384, (1,)); os.close(source_final_fd)
                os.fsync(bundle_fd)
                os.fsync(bundles_fd)
                os.fsync(receipts_fd)
                os.fsync(staging_fd)
                revalidate_bound_entry(bundles_fd, artifact_sha, bundle_fd, bundle_identity)
                custody_bytes = build_custody_receipt(root, owner, artifact, artifact_sha, checksum_sha, backup_receipt_sha, source_receipt_sha, expected_layout)
                custody_sha = hashlib.sha256(custody_bytes).hexdigest()
                temp_name = f".{nonce}.custody.tmp"
                temp_fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=receipts_fd)
                try:
                    view = memoryview(custody_bytes)
                    while view:
                        written = os.write(temp_fd, view)
                        if written < 1: fail()
                        view = view[written:]
                    os.fsync(temp_fd)
                finally:
                    os.close(temp_fd)
                temp_read = open_final_file(receipts_fd, temp_name, uid, custody_sha, 4096, (1,))
                try:
                    validate_custody_bytes(read_fd(temp_read, 4096), root, owner, artifact, artifact_sha, checksum_sha, backup_receipt_sha, source_receipt_sha, expected_layout)
                    require_layout_proof(expected_layout, records, layout)
                    revalidate_bound_entry(bundles_fd, artifact_sha, bundle_fd, bundle_identity)
                    try: os.stat(nonce, dir_fd=staging_fd, follow_symlinks=False); fail()
                    except FileNotFoundError: pass
                    revalidate_chain(records)
                    require_layout_proof(expected_layout, records, layout)
                    os.close(bundle_fd)
                    bundle_fd = -1
                    publish_receipt_no_replace(receipts_fd, temp_read, temp_name, custody_name)
                    temp_read = -1
                finally:
                    if temp_read >= 0:
                        try: os.close(temp_read)
                        except OSError: pass
            finally:
                if bundle_fd >= 0:
                    try: os.close(bundle_fd)
                    except OSError: pass
            print(f"a1of1_backup_published=true\na1of1_idempotent=false\nartifact_sha256={artifact_sha}\ncustody_receipt_sha256={custody_sha}\ncustody_receipt_path={root}/receipts/{custody_name}")
        else:
            fail()
    finally:
        for fd in reversed(fds):
            try: os.close(fd)
            except OSError: pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("a1of1_publish_rejected\n")
        sys.exit(1)
