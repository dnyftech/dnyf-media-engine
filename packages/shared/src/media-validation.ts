export interface MediaValidationResult {
  valid: boolean;
  duration?: number;
  format?: string;
  videoCodec?: string;
  audioCodec?: string;
  sampleRate?: number;
  channels?: number;
  reason?: string;
}
