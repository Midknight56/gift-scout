export interface Channel3FlagEnv {
  CHANNEL3?: string
  CHANNEL3_API_KEY?: string
}

export function channel3Enabled(env: Channel3FlagEnv): boolean {
  return env.CHANNEL3 === 'on' && Boolean(env.CHANNEL3_API_KEY)
}
