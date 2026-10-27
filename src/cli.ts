/**
 * A command's positional arguments, or its usage and an exit when any is a
 * flag. Commands an agent runs mostly take paths, so `--help` would be taken
 * for one: an agent asking for help once had a whole run's output written to
 * a directory of that name.
 */
export function positional(usage: string): (string | undefined)[] {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg.startsWith("-"))) {
    console.log(`usage: ${usage}`);
    process.exit(args.includes("--help") || args.includes("-h") ? 0 : 2);
  }
  return args;
}
