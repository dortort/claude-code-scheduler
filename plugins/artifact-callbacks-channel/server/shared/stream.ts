// Reply streaming (M5): the NDJSON file the sidecar replays and tails for
// `GET /_cb/events/<id>/stream`. Lines: `{"type":"text","text":...}`,
// `{"type":"state","state":...}`, `{"type":"end"}`.

/** Characters of reply text kept per event; later text is not streamed. */
export const STREAM_TEXT_CAP = 1_000_000
/** How long text deltas gather before the file is written again. */
export const STREAM_FLUSH_MS = 250

export class ReplyStream {
  private readonly lines: string[] = []
  private textChars = 0
  private isEnded = false
  private isTruncated = false

  text(delta: string): boolean {
    if (this.isEnded || delta === '') return false
    const room = STREAM_TEXT_CAP - this.textChars
    if (room <= 0) {
      this.isTruncated = true
      return false
    }
    const piece = delta.length > room ? delta.slice(0, room) : delta
    this.textChars += piece.length
    this.lines.push(JSON.stringify({ type: 'text', text: piece }))
    return true
  }

  state(state: string): boolean {
    if (this.isEnded) return false
    this.lines.push(JSON.stringify({ type: 'state', state }))
    return true
  }

  end(): boolean {
    if (this.isEnded) return false
    this.isEnded = true
    this.lines.push(JSON.stringify({ type: 'end' }))
    return true
  }

  get ended(): boolean {
    return this.isEnded
  }

  get truncated(): boolean {
    return this.isTruncated
  }

  /** The whole file: every line so far, each ending in a newline. */
  toString(): string {
    return this.lines.length === 0 ? '' : `${this.lines.join('\n')}\n`
  }
}
