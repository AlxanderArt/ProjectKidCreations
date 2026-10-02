#!/usr/bin/env python3
import os
import stat
import subprocess
import sys

REQUIRED = {
    "postgres_bootstrap_password",
    "postgres_server_cert",
    "postgres_server_key",
    "postgres_server_ca",
    "postgres_client_ca",
}
MAX_BYTES = 1024 * 1024


def fail(message):
    raise SystemExit(f"secret validation failed: {message}")


def run_openssl(arguments, descriptors):
    result = subprocess.run(
        ["openssl", *arguments],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        pass_fds=tuple(descriptors),
        check=False,
    )
    if result.returncode != 0:
        fail("cryptographic material invalid")
    return result.stdout


def descriptor_path(descriptor):
    return f"/proc/self/fd/{descriptor}"


def main():
    if len(sys.argv) != 2:
        fail("usage: validate-secrets.py ABSOLUTE_DIRECTORY")
    root = sys.argv[1]
    if not os.path.isabs(root):
        fail("absolute directory required")
    root_stat = os.lstat(root)
    if not stat.S_ISDIR(root_stat.st_mode) or stat.S_ISLNK(root_stat.st_mode):
        fail("directory must be real and non-symlinked")
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    descriptors = {}
    try:
        names = set(os.listdir(root_fd))
        if names != REQUIRED:
            fail("closed filename schema mismatch")
        allowed_owners = {0, os.getuid(), 70}
        values = {}
        for name in sorted(REQUIRED):
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root_fd)
            descriptors[name] = descriptor
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode):
                fail(f"{name}: regular file required")
            if before.st_uid not in allowed_owners:
                fail(f"{name}: owner rejected")
            if stat.S_IMODE(before.st_mode) not in {0o400, 0o600}:
                fail(f"{name}: mode must be 0400 or 0600")
            if before.st_size < 1 or before.st_size > MAX_BYTES:
                fail(f"{name}: size rejected")
            chunks = []
            remaining = MAX_BYTES + 1
            while remaining > 0:
                chunk = os.read(descriptor, min(65536, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            data = b"".join(chunks)
            after = os.fstat(descriptor)
            if (before.st_dev, before.st_ino, before.st_mode, before.st_uid, before.st_gid, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_mode, after.st_uid, after.st_gid, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                fail(f"{name}: descriptor identity changed")
            values[name] = data

        bootstrap_material = values["postgres_bootstrap_password"].rstrip(b"\n")
        if len(bootstrap_material) < 32 or b"\n" in bootstrap_material or any(byte in b" \t:" for byte in bootstrap_material):
            fail("postgres_bootstrap_password: invalid shape")

        cert_names = ["postgres_server_cert", "postgres_server_ca", "postgres_client_ca"]
        for name in cert_names:
            descriptor = descriptors[name]
            run_openssl(["x509", "-in", descriptor_path(descriptor), "-noout", "-checkend", "604800"], [descriptor])
        key_descriptor = descriptors["postgres_server_key"]
        cert_descriptor = descriptors["postgres_server_cert"]
        server_ca_descriptor = descriptors["postgres_server_ca"]
        client_ca_descriptor = descriptors["postgres_client_ca"]
        run_openssl(["pkey", "-in", descriptor_path(key_descriptor), "-noout", "-check"], [key_descriptor])
        run_openssl(["verify", "-CAfile", descriptor_path(server_ca_descriptor), descriptor_path(cert_descriptor)], [server_ca_descriptor, cert_descriptor])
        run_openssl(["verify", "-CAfile", descriptor_path(client_ca_descriptor), descriptor_path(client_ca_descriptor)], [client_ca_descriptor])
        cert_public = run_openssl(["x509", "-in", descriptor_path(cert_descriptor), "-pubkey", "-noout"], [cert_descriptor])
        key_public = run_openssl(["pkey", "-in", descriptor_path(key_descriptor), "-pubout"], [key_descriptor])
        if cert_public != key_public:
            fail("server certificate/key mismatch")
    finally:
        for descriptor in descriptors.values():
            os.close(descriptor)
        os.close(root_fd)
    print("secret_schema_valid=true")


if __name__ == "__main__":
    main()
