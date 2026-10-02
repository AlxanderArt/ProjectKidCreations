import { loadPgClientAuthority } from "./client-authority.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) throw new Error("client_authority_arguments_invalid");
  return args[index + 1];
};

try {
  const connectionString = value("--connection-string");
  const expectedUser = args.includes("--expected-user") ? value("--expected-user") : null;
  await loadPgClientAuthority({
    connectionString,
    pgpassFile: value("--pgpass-file"),
  });
  if (expectedUser !== null && new URL(connectionString).username !== expectedUser) throw new Error("client_authority_user_invalid");
  process.stdout.write("client_authority_valid=true\n");
} catch {
  process.stderr.write("client_authority_invalid\n");
  process.exitCode = 1;
}
