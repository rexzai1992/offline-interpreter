declare module '@fugood/react-native-audio-pcm-stream' {
  export interface Options {
    sampleRate: number
    channels: number
    bitsPerSample: number
    audioSource?: number
    wavFile: string
    bufferSize?: number
  }
  export interface IAudioRecord {
    init: (options: Options) => void
    start: () => void
    stop: () => Promise<string>
    on: (event: 'data', callback: (data: string) => void) => void
  }
  const AudioRecord: IAudioRecord
  export default AudioRecord
}
