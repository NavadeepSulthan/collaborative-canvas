import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { BackplaneKind, type BackplaneMessage } from './ports.js';

/** Compact binary framing for backplane messages: [origin:varstring][kind:varuint][payload:varbytes]. */
export function encodeEnvelope(message: BackplaneMessage): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, message.origin);
  encoding.writeVarUint(encoder, message.kind);
  encoding.writeVarUint8Array(encoder, message.payload);
  return encoding.toUint8Array(encoder);
}

export function decodeEnvelope(data: Uint8Array): BackplaneMessage {
  const decoder = decoding.createDecoder(data);
  const origin = decoding.readVarString(decoder);
  const kind = decoding.readVarUint(decoder);
  if (!Object.values(BackplaneKind).includes(kind as BackplaneKind)) {
    throw new Error(`Unknown backplane message kind ${kind}`);
  }
  const payload = decoding.readVarUint8Array(decoder);
  return { origin, kind: kind as BackplaneKind, payload };
}
