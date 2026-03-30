/**
 * Extract the H.264 fmtp parameter string from an SDP.
 *
 * Finds the video media section, identifies the H264 payload type from
 * the rtpmap line, and returns the fmtp parameter string for that type.
 * Line order within the section is not assumed (fmtp may precede rtpmap).
 * If multiple H264 payload types exist, the first one found is used.
 *
 * @returns The fmtp parameter string, or null if not found.
 */
export function parseH264Fmtp(sdp: string): string | null {
  const lines = sdp.split(/\r?\n/);

  let inVideoSection = false;
  let h264PayloadType: string | null = null;
  const fmtps = new Map<string, string>();

  for (const line of lines) {
    if (line.startsWith('m=video')) {
      inVideoSection = true;
      continue;
    }
    if (line.startsWith('m=') && inVideoSection) {
      break;
    }
    if (!inVideoSection) continue;

    const rtpmapMatch = line.match(/^a=rtpmap:(\d+)\s+H264\/90000/i);
    if (rtpmapMatch) {
      h264PayloadType = rtpmapMatch[1];
    }

    const fmtpMatch = line.match(/^a=fmtp:(\d+)\s+(.+)$/);
    if (fmtpMatch) {
      fmtps.set(fmtpMatch[1], fmtpMatch[2].trim());
    }
  }

  if (!h264PayloadType) return null;
  return fmtps.get(h264PayloadType) ?? null;
}
