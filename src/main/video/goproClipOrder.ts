import { basename, dirname } from 'path'

export interface GoProClipName {
  chapter: number
  recordingId: string
}

interface ParsedClip {
  filePath: string
  fileName: string
  directory: string
  chapter: number
  recordingId: string
}

// Modern GoPro chapter names: GH011552.MP4, GX021552.MP4, etc. The two digits
// are the chapter and the final four identify the recording. Older cameras use
// GOPR1552.MP4 for the first file followed by GP011552.MP4, GP021552.MP4, ...
const MODERN_GOPRO_CLIP = /^G[A-Z](\d{2})(\d{4})\.(?:MP4|MOV)$/i
const LEGACY_GOPRO_FIRST_CLIP = /^GOPR(\d{4})\.(?:MP4|MOV)$/i

export function parseGoProClipName(fileName: string): GoProClipName | null {
  const modern = MODERN_GOPRO_CLIP.exec(fileName)
  if (modern) {
    return { chapter: Number(modern[1]), recordingId: modern[2] }
  }

  const legacyFirst = LEGACY_GOPRO_FIRST_CLIP.exec(fileName)
  if (legacyFirst) {
    return { chapter: 0, recordingId: legacyFirst[1] }
  }

  return null
}

function formatGroup(group: ParsedClip[]): string {
  const first = group[0]
  const files = group.map((clip) => clip.fileName).sort().join(', ')
  return `Recording ${first.recordingId} (${first.directory}): ${files}`
}

/**
 * Orders chapters from one GoPro recording and rejects selections that would
 * silently interleave multiple recordings into the app's single contiguous
 * timeline. Unknown naming schemes retain the previous alphabetical behavior.
 */
export function orderAndValidateGoProClipPaths(filePaths: string[]): string[] {
  if (filePaths.length <= 1) return [...filePaths]

  const parsed = filePaths.map((filePath): ParsedClip | null => {
    const fileName = basename(filePath)
    const clip = parseGoProClipName(fileName)
    if (!clip) return null
    return {
      filePath,
      fileName,
      directory: dirname(filePath),
      chapter: clip.chapter,
      recordingId: clip.recordingId
    }
  })

  // Preserve compatibility with arbitrary MP4/MOV names. We can only enforce
  // GoPro recording/chapter semantics when every selected file follows one of
  // the known GoPro naming schemes.
  if (parsed.some((clip) => clip === null)) return [...filePaths].sort()

  const clips = parsed as ParsedClip[]
  const groups = new Map<string, ParsedClip[]>()
  for (const clip of clips) {
    const key = `${clip.directory.toLowerCase()}\0${clip.recordingId}`
    const group = groups.get(key)
    if (group) group.push(clip)
    else groups.set(key, [clip])
  }

  if (groups.size > 1) {
    const details = [...groups.values()].map(formatGroup).join('\n')
    throw new Error(
      `Selected files belong to multiple GoPro recordings:\n${details}\nImport each recording as a separate project.`
    )
  }

  const ordered = [...clips].sort((a, b) => a.chapter - b.chapter)
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]
    const current = ordered[i]
    if (current.chapter === previous.chapter) {
      throw new Error(
        `Duplicate GoPro chapter ${String(current.chapter).padStart(2, '0')} selected for recording ${current.recordingId}.`
      )
    }
    if (current.chapter !== previous.chapter + 1) {
      throw new Error(
        `GoPro recording ${current.recordingId} has a missing chapter between ${previous.fileName} and ${current.fileName}. Select every contiguous chapter, or import the clips as separate projects.`
      )
    }
  }

  return ordered.map((clip) => clip.filePath)
}
