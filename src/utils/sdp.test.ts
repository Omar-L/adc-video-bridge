import { describe, it, expect } from 'vitest';
import { parseH264Fmtp } from './sdp.js';

/** Realistic ADC camera SDP offer with full H.264 parameters. */
const STANDARD_SDP = [
  'v=0',
  'o=- 3933259940 3933259940 IN IP4 0.0.0.0',
  's=ADC WebRTC Session',
  'c=IN IP4 0.0.0.0',
  't=0 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=rtpmap:96 H264/90000',
  'a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f;sprop-parameter-sets=Z00AH+dAKALdgIAAAPpAADqYA8UKZYA==,aO48gA==',
  'a=sendonly',
  'a=mid:video',
].join('\r\n');

describe('parseH264Fmtp', () => {
  it('parses standard SDP with profile-level-id and sprop-parameter-sets', () => {
    const result = parseH264Fmtp(STANDARD_SDP);
    expect(result).toBe(
      'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f;sprop-parameter-sets=Z00AH+dAKALdgIAAAPpAADqYA8UKZYA==,aO48gA==',
    );
  });

  it('handles fmtp line appearing before rtpmap line', () => {
    const sdp = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=fmtp:96 packetization-mode=1;profile-level-id=42e01f',
      'a=rtpmap:96 H264/90000',
    ].join('\r\n');

    expect(parseH264Fmtp(sdp)).toBe('packetization-mode=1;profile-level-id=42e01f');
  });

  it('handles non-96 payload type', () => {
    const sdp = [
      'v=0',
      'm=video 9 RTP/AVP 111',
      'a=rtpmap:111 H264/90000',
      'a=fmtp:111 packetization-mode=1;profile-level-id=640028',
    ].join('\n');

    expect(parseH264Fmtp(sdp)).toBe('packetization-mode=1;profile-level-id=640028');
  });

  it('returns null when no video section exists', () => {
    const sdp = [
      'v=0',
      'm=audio 9 RTP/AVP 0',
      'a=rtpmap:0 PCMU/8000',
    ].join('\n');

    expect(parseH264Fmtp(sdp)).toBeNull();
  });

  it('returns null when no H264 rtpmap exists', () => {
    const sdp = [
      'v=0',
      'm=video 9 RTP/AVP 96',
      'a=rtpmap:96 VP8/90000',
      'a=fmtp:96 some-param=1',
    ].join('\n');

    expect(parseH264Fmtp(sdp)).toBeNull();
  });

  it('returns null when H264 rtpmap exists but no matching fmtp', () => {
    const sdp = [
      'v=0',
      'm=video 9 RTP/AVP 96',
      'a=rtpmap:96 H264/90000',
      'a=sendonly',
    ].join('\n');

    expect(parseH264Fmtp(sdp)).toBeNull();
  });

  it('ignores fmtp from audio section', () => {
    const sdp = [
      'v=0',
      'm=audio 9 RTP/AVP 96',
      'a=rtpmap:96 opus/48000',
      'a=fmtp:96 minptime=10;useinbandfec=1',
      'm=video 9 RTP/AVP 97',
      'a=rtpmap:97 H264/90000',
    ].join('\n');

    // H264 has no fmtp in the video section — audio fmtp should NOT bleed over
    expect(parseH264Fmtp(sdp)).toBeNull();
  });

  it('handles CRLF line endings', () => {
    const sdp = 'v=0\r\nm=video 9 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1\r\n';
    expect(parseH264Fmtp(sdp)).toBe('packetization-mode=1');
  });

  it('handles LF-only line endings', () => {
    const sdp = 'v=0\nm=video 9 RTP/AVP 96\na=rtpmap:96 H264/90000\na=fmtp:96 packetization-mode=1\n';
    expect(parseH264Fmtp(sdp)).toBe('packetization-mode=1');
  });

  it('returns null for empty string', () => {
    expect(parseH264Fmtp('')).toBeNull();
  });

  it('returns null for non-SDP input', () => {
    expect(parseH264Fmtp('hello world')).toBeNull();
  });

  it('picks H264 fmtp when multiple codecs are present', () => {
    const sdp = [
      'v=0',
      'm=video 9 RTP/AVP 96 97',
      'a=rtpmap:96 VP8/90000',
      'a=fmtp:96 max-fs=3600',
      'a=rtpmap:97 H264/90000',
      'a=fmtp:97 packetization-mode=1;profile-level-id=4d001f',
    ].join('\n');

    expect(parseH264Fmtp(sdp)).toBe('packetization-mode=1;profile-level-id=4d001f');
  });

  it('trims trailing whitespace from fmtp parameters', () => {
    const sdp = [
      'v=0',
      'm=video 9 RTP/AVP 96',
      'a=rtpmap:96 H264/90000',
      'a=fmtp:96 packetization-mode=1   ',
    ].join('\n');

    expect(parseH264Fmtp(sdp)).toBe('packetization-mode=1');
  });
});
