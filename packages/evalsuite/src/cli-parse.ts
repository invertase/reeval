import { Command, type CommanderError, Option } from 'commander'
import { COMMANDS, FLAGS, type FlagName, type Flags, GLOBAL } from './cli-spec.ts'
import { UsageError } from './config.ts'

/** What `es` was asked: the command path and its arguments, then every flag given. */
export type ParsedCli = { positionals: string[]; values: Flags }

const OPTIONS: Record<FlagName, () => Option> = Object.fromEntries(
  Object.entries(FLAGS).map(([name, spec]) => {
    const short = 'short' in spec ? `-${spec.short}, ` : ''
    const value = spec.type === 'string' ? ' <value>' : ''
    return [
      name,
      () => {
        const option = new Option(`${short}--${name}${value}`)
        if ('multiple' in spec && spec.multiple) {
          // Every occurrence is kept, as `-vv` or `--tag a --tag b`.
          option.argParser((v: string | undefined, prev: unknown[] = []) => [
            ...prev,
            spec.type === 'string' ? v : true,
          ])
        }
        return option
      },
    ]
  }),
) as Record<FlagName, () => Option>

/**
 * Parses `argv` against the CLI spec with commander. A flag belongs to the commands that list it
 * (and `--config`, `--help` and `--version` to all of them); a flag of another command, a
 * missing value or too many arguments is a UsageError. `--help` and `--version` skip the
 * argument count, so the dispatcher can print them.
 */
export function parseCli(argv: string[]): ParsedCli {
  let parsed: ParsedCli | undefined
  const program = configure(new Command('es'), 'es', GLOBAL)
  program.argument('[args...]').action(() => {
    parsed = { positionals: program.args, values: valuesOf(program, GLOBAL) }
  })
  for (const [name, spec] of Object.entries(COMMANDS)) {
    const command = configure(program.command(name), `es ${name}`, spec.flags)
    command.argument('[args...]').action(() => {
      // `es image` has no action of its own: the dispatcher names its subcommand.
      const max = spec.sub && !spec.help ? Number.POSITIVE_INFINITY : spec.positionals
      parsed = done(program, command, [name], spec.flags, max)
    })
    for (const [subName, sub] of Object.entries(spec.sub ?? {})) {
      const subcommand = configure(command.command(subName), `es ${name} ${subName}`, sub.flags)
      subcommand.argument('[args...]').action(() => {
        // commander hands the parent its own flags wherever they are, as it does `--config`.
        const [stray] = Object.keys(valuesOf(command, spec.flags))
        if (stray) throw new UsageError(`--${stray} isn't an option of es ${name} ${subName}`)
        parsed = done(program, subcommand, [name, subName], sub.flags, sub.positionals)
      })
    }
  }
  program.parse(argv, { from: 'user' })
  if (!parsed) throw new UsageError('Run es --help.')
  return parsed
}

function configure(command: Command, name: string, flags: FlagName[]): Command {
  command
    .helpOption(false)
    .helpCommand(false)
    .allowExcessArguments()
    .configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} })
    .exitOverride((error) => {
      throw usageError(error, name)
    })
  for (const flag of flags) command.addOption(OPTIONS[flag]())
  return command
}

function done(
  program: Command,
  command: Command,
  path: string[],
  flags: FlagName[],
  max: number,
): ParsedCli {
  const values = { ...valuesOf(program, GLOBAL), ...valuesOf(command, flags) }
  const args = command.args
  if (!values.help && !values.version && args.length > max) {
    const name = `es ${path.join(' ')}`
    throw new UsageError(
      max === 0
        ? `${name} takes no arguments (got ${args.join(' ')})`
        : `${name} takes at most ${max} argument${max === 1 ? '' : 's'} (got ${args.join(' ')})`,
    )
  }
  return { positionals: [...path, ...args], values }
}

/** The flags given, under their spec names; a `--no-*` flag is true when given. */
function valuesOf(command: Command, flags: FlagName[]): Flags {
  const opts = command.opts()
  const values: Record<string, unknown> = {}
  for (const flag of flags) {
    const option = command.options.find((o) => o.long === `--${flag}`)
    const value = option && opts[option.attributeName()]
    if (option?.negate) {
      if (value === false) values[flag] = true
    } else if (value !== undefined) values[flag] = value
  }
  return values as Flags
}

/** Commander's error, in ES's words, naming the command whose flag it is. */
function usageError(error: CommanderError, command: string): UsageError {
  const text = error.message.replace(/^error: /, '')
  const [first = '', ...rest] = text.split('\n')
  if (error.code === 'commander.unknownOption') {
    const arg = /'([^']+)'/.exec(first)?.[1] ?? ''
    const [flag = '', value] = arg.replace(/^--?/, '').split('=')
    const known = arg.startsWith('--')
      ? (FLAGS as Record<string, { type: string }>)[flag]
      : Object.entries(FLAGS).find(([, s]) => 'short' in s && s.short === flag)?.[1]
    const long = arg.startsWith('--')
      ? flag
      : Object.entries(FLAGS).find(([, s]) => 'short' in s && s.short === flag)?.[0]
    if (known && value !== undefined && known.type === 'boolean') {
      return new UsageError(`Option '--${flag}' does not take an argument`)
    }
    if (known) return new UsageError(`--${long} isn't an option of ${command}. Run es --help.`)
    const hint = rest.join(' ').replace(/^\(|\)$/g, '')
    return new UsageError(`Unknown option '${arg}'. ${hint ? `${hint} ` : ''}Run es --help.`)
  }
  return new UsageError(first.charAt(0).toUpperCase() + first.slice(1))
}
