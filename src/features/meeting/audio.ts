import { asrAudioAppend, asrAudioClear, asrAudioClose, asrAudioOpen } from './asr'

/**
 * 录音 → 16k 单声道 PCM → 宿主。
 *
 * 页面里不装 ffmpeg：浏览器能解的格式（webm/opus、mp3、wav、m4a、ogg）交给
 * decodeAudioData，解完立刻边下采样边送给宿主，页面自身只留一小段 PCM。
 * 两小时会议的 PCM 有 200MB+，绝不能攒在 JS 里。
 */

const TARGET_RATE = 16_000
/** 每片 8 秒（128000 样本 = 256KB PCM）：base64 后约 340KB，消息通道扛得住 */
const OUT_SAMPLES_PER_CHUNK = 128_000
/** 麦克风分段录制的时间片：够短，异常中断也只丢最后几秒 */
const RECORD_TIMESLICE_MS = 30_000
/** 上传文件的大小上限。解码后的浮点数据比原文件大好几倍，再高就等着 OOM */
export const MAX_UPLOAD_BYTES = 120 * 1024 * 1024

export class AudioStreamError extends Error {}

let sharedDecodeContext: OfflineAudioContext | null = null

function decodeContext(): OfflineAudioContext {
  if (!sharedDecodeContext) {
    // OfflineAudioContext 只当解码器用，不会打开音频设备
    sharedDecodeContext = new OfflineAudioContext(1, 1, TARGET_RATE)
  }
  return sharedDecodeContext
}

/** 解一个音频文件/分片；失败统一抛 AudioStreamError，让界面能说清是哪一段出了问题 */
async function decode(data: ArrayBuffer): Promise<AudioBuffer> {
  if (data.byteLength === 0) throw new AudioStreamError('音频分片为空')
  try {
    return await decodeContext().decodeAudioData(data)
  } catch {
    throw new AudioStreamError('无法解码这段音频，格式可能不受支持（wma、amr、silk 等）')
  }
}

/** 取 [outFrom, outTo) 这段输出样本，混成单声道并重采样为 16 位小端 PCM */
function slicePcm(buffer: AudioBuffer, outFrom: number, outTo: number): Uint8Array {
  const channels = Math.min(2, buffer.numberOfChannels)
  const data: Float32Array[] = []
  for (let c = 0; c < channels; c += 1) data.push(buffer.getChannelData(c))
  const ratio = buffer.sampleRate / TARGET_RATE
  const length = outTo - outFrom
  const out = new Uint8Array(length * 2)
  const view = new DataView(out.buffer)

  for (let j = 0; j < length; j += 1) {
    const position = (outFrom + j) * ratio
    const index = Math.floor(position)
    const fraction = position - index
    let mixed = data[0] ? (data[0][index] ?? 0) : 0
    for (let c = 1; c < channels; c += 1) {
      const channel = data[c]
      if (!channel) continue
      mixed += channel[index] ?? 0
    }
    if (channels > 1) mixed /= channels

    let next = mixed
    if (index + 1 < buffer.length) {
      let mixedNext = data[0] ? (data[0][index + 1] ?? 0) : 0
      for (let c = 1; c < channels; c += 1) {
        const channel = data[c]
        if (!channel) continue
        mixedNext += channel[index + 1] ?? 0
      }
      if (channels > 1) mixedNext /= channels
      next = mixed + (mixedNext - mixed) * fraction
    }

    const clamped = Math.max(-1, Math.min(1, next))
    view.setInt16(j * 2, clamped < 0 ? clamped * 32768 : clamped * 32767, true)
  }
  return out
}

/**
 * 解码 + 重采样 + 逐片送宿主。
 * 返回送给宿主的总秒数；宿主按 key 拼成一个完整 wav。
 */
async function pipeBufferToHost(key: string, buffer: AudioBuffer): Promise<number> {
  const total = Math.ceil(buffer.duration * TARGET_RATE)
  for (let from = 0; from < total; from += OUT_SAMPLES_PER_CHUNK) {
    const to = Math.min(from + OUT_SAMPLES_PER_CHUNK, total)
    await asrAudioAppend(key, slicePcm(buffer, from, to))
  }
  return Math.round(buffer.duration)
}

export interface SendProgress {
  /** 已送入宿主的音频秒数 */
  seconds: number
  /** 已处理的片段数（麦克风路径按时间片计数） */
  parts: number
}

/** 上传的录音文件：整段解码后分片送宿主，返回音频总秒数 */
export async function sendFile(key: string, file: File): Promise<number> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new AudioStreamError(
      `文件超过 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB，浏览器解码会撑爆内存。` +
        '建议改用「开始会议」直接录，或先把长录音转成 mp3 再传。',
    )
  }
  const buffer = await decode(await file.arrayBuffer())
  await asrAudioOpen(key)
  try {
    const seconds = await pipeBufferToHost(key, buffer)
    await asrAudioClose(key)
    return seconds
  } catch (err) {
    asrAudioClear(key)
    throw new AudioStreamError(err instanceof Error ? err.message : String(err))
  }
}

// ---------- 麦克风 ----------

function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type
  }
  return ''
}

/**
 * 会议录音器：每 30 秒切一个 webm 分片，片尾一到就解码、重采样、送宿主。
 * 所以录音期间内存里最多只有一片的浮点数据。
 */
export class MeetingRecorder {
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private startedAt = 0
  private closed = false
  /** 每个已完成分片解码后依次排队，保证写盘顺序和说话顺序一致 */
  private queue: Promise<void> = Promise.resolve()
  private partsSent = 0
  private secondsSent = 0

  constructor(
    private readonly key: string,
    private readonly onPart?: (p: SendProgress) => void,
    private readonly onError?: (message: string) => void,
  ) {}

  get active(): boolean {
    return this.recorder !== null && !this.closed
  }

  elapsedSeconds(): number {
    return this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0
  }

  async start(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new AudioStreamError('当前环境没有麦克风接口')
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })
    this.stream = stream

    const mimeType = pickMimeType()
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      bitsPerSecond: 32_000,
    })
    this.recorder = recorder

    recorder.ondataavailable = (event) => {
      const blob = event.data
      if (!blob || blob.size === 0) return
      // 串行：前一片解码写完再解下一片，否则宿主收到的 PCM 顺序会乱
      this.queue = this.queue.then(() => this.consume(blob)).catch(() => undefined)
    }

    try {
      await asrAudioOpen(this.key)
    } catch (err) {
      this.releaseTracks()
      this.recorder = null
      throw new AudioStreamError(err instanceof Error ? err.message : String(err))
    }

    this.startedAt = Date.now()
    recorder.start(RECORD_TIMESLICE_MS)
  }

  private async consume(blob: Blob): Promise<void> {
    try {
      const buffer = await decode(await blob.arrayBuffer())
      const seconds = await pipeBufferToHost(this.key, buffer)
      this.secondsSent += seconds
      this.partsSent += 1
      this.onPart?.({ seconds: this.secondsSent, parts: this.partsSent })
    } catch (err) {
      this.onError?.(err instanceof Error ? err.message : String(err))
    }
  }

  /** 停止录制并把最后一片送完；返回总秒数 */
  async stop(): Promise<number> {
    if (!this.recorder) return this.secondsSent
    const recorder = this.recorder
    this.recorder = null
    const lastChunk = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
      try {
        recorder.stop()
      } catch {
        resolve()
      }
    })
    await lastChunk
    this.releaseTracks()
    // 等队列把剩余分片解完、写完，再补 wav 头
    await this.queue
    this.closed = true
    const result = await asrAudioClose(this.key)
    this.secondsSent = result.seconds
    return result.seconds
  }

  /** 用户反悔：丢掉这次录音，不留半截文件 */
  async discard(): Promise<void> {
    this.recorder = null
    this.releaseTracks()
    await this.queue.catch(() => undefined)
    if (!this.closed) asrAudioClear(this.key)
    this.closed = true
  }

  private releaseTracks(): void {
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
  }
}
