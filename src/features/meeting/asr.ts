import { callHost, onHostEvent, type AsrSegment, type HostEvent } from '../../core/file/webview'

/**
 * 会记的本地语音转写通道。
 *
 * 模型（SenseVoice + silero VAD）与 ffmpeg 都不在页面里跑：音频由宿主落盘、
 * 由宿主拉起的 sherpa-onnx 命令行转写，页面只发参数、收事件。
 * 所以浏览器版 mdreader 只能用「导入转写文本」这条路。
 */

export interface AsrStatus {
  ready: boolean
  dir: string
  version: number
  error: string
  threads: number
}

export interface AsrInstallResult {
  ready?: boolean
  dir?: string
  version?: number
  cancelled?: boolean
  segments?: AsrSegment[]
  seconds?: number
}

export type AsrHostEvent = Extract<HostEvent, { event: `asr${string}` }>

export function asrStatus(): Promise<AsrStatus> {
  return callHost<AsrStatus>('asrStatus')
}

export function asrInstall(url: string, requestId: number): Promise<void> {
  return callHost('asrInstall', { url, requestId }).then(() => undefined)
}

export function asrInstallFromZip(requestId: number): Promise<void> {
  return callHost('asrInstallZip', { requestId }).then(() => undefined)
}

export function asrCancel(requestId: number): void {
  void callHost('asrCancel', { requestId }).catch(() => undefined)
}

export function asrAudioOpen(key: string): Promise<void> {
  return callHost('asrAudioOpen', { key }).then(() => undefined)
}

/** 一次一片，串行发送：宿主按到达顺序写盘，并发会打乱音频字节序 */
export async function asrAudioAppend(key: string, pcm: Uint8Array): Promise<void> {
  await callHost('asrAudioAppend', { key, base64: toBase64(pcm) })
}

export function asrAudioClose(key: string): Promise<{ path: string; bytes: number; seconds: number }> {
  return callHost('asrAudioClose', { key })
}

export function asrAudioClear(key: string): void {
  void callHost('asrAudioClear', { key }).catch(() => undefined)
}

export function asrTranscribe(key: string, requestId: number, threads: number): Promise<void> {
  return callHost('asrTranscribe', { key, requestId, threads }).then(() => undefined)
}

export function onAsrEvent(cb: (event: AsrHostEvent) => void): () => void {
  return onHostEvent((event) => {
    if (event.event.startsWith('asr')) cb(event as AsrHostEvent)
  })
}

/** 分片 base64：逐字节拼接在大文件上会退化成 O(n²)，按块 String.fromCharCode 再 join */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  const parts: string[] = []
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const slice = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length))
    let binary = ''
    for (let i = 0; i < slice.length; i += 1) binary += String.fromCharCode(slice[i]!)
    parts.push(binary)
  }
  return btoa(parts.join(''))
}
