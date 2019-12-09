// Copyright 2019 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// 
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

function isDigit(c) {
  let charCode = c.charCodeAt(0);
  return (charCode >= 48 && charCode <= 57); // '0'-'9'
}
/* Compression methods return null if no compression, otherwise they return
 * [length of string consumed, length of compressed bytes].
 * Decompression methods return [length of input consumed, output string].
 */

// Dictionary of common substrings within RTCSession / ICECandidates.
const DICTIONARY = [
  '{"type":"offer","sdp":"v=',
  '\\r\\na=max-message-size:',
  ',{"candidate":"candidate:',
  '{"candidate":"candidate:',
  '\\r\\na=msid-semantic:',
  '\\r\\na=ice-options:',
  '\\r\\na=fingerprint:',
  '\\r\\na=ice-ufrag:',
  '\\r\\na=sctp-port:',
  'webrtc-datachannel',
  '\\r\\na=ice-pwd:',
  '"sdpMLineIndex":0}',
  '"sdpMLineIndex":',
  ' network-cost ',
  '\\r\\na=setup:',
  '\\r\\na=group:',
  'm=application',
  'UDP/DTLS/SCTP',
  '"sdpMid":"0",',
  ' network-id ',
  ' generation',
  '"sdpMid":',
  '\\r\\no=',
  '\\r\\nt=',
  '\\r\\ns=',
  '\\r\\nc=',
  'typ host',
  ' tcptype',
  'IN IP4 ',
  'actpass',
  'trickle',
  'sha-256',
  ' active',
  'BUNDLE',
  'a=mid:',
  ' ufrag',
  '\\r\\n',
  'type',
  'JRmH',
  ' udp',
  ' tcp',
  'WMS',
  '},{',
  '"0",',
  ' 1',
  ' 9',
  '",',
];

// First code point to use.
const FIRST_CODEPOINT = 176;

// Generate a number encoder for the given view type (i.e. Uint8Array).
function generateNumberEncoder(viewType, saturate) {
  let maxValue = Math.pow(2, viewType.BYTES_PER_ELEMENT * 8) - 1;
  let maxValueStr = String(maxValue);
  return {
    name: viewType.name.substring(0, viewType.name.indexOf('Array')),
    compress: (str, ipos, ab, opos) => {
      // Integer encoding doesn't handle leading 0's.
      if (str[ipos] == '0')
        return null;
      let endPos = ipos;
      while (str.length > endPos && isDigit(str[endPos]))
        endPos++;
      // Don't encode if it won't save space.
      if (endPos - ipos < 1 + viewType.BYTES_PER_ELEMENT)
        return null;
      let value = parseInt(str.substring(ipos, endPos));
      if (value > maxValue) {
        if (!saturate)
          return null;
        // Determine an appropriate ending location within size.
        endPos = Math.min(endPos, ipos + maxValueStr.length);
        if (parseInt(str.substring(ipos, endPos)) > maxValue)
          endPos--;
        value = parseInt(str.substring(ipos, endPos));
      }
      let temp = new ArrayBuffer(viewType.BYTES_PER_ELEMENT);
      let tempOutput = new viewType(temp);
      tempOutput[0] = value;
      let inputBytes = new Uint8Array(temp);
      let outputBytes = new Uint8Array(ab, opos);
      for (let i = 0; i < viewType.BYTES_PER_ELEMENT; i++)
        outputBytes[i] = inputBytes[i];
      return [endPos - ipos, viewType.BYTES_PER_ELEMENT];
    },
    decompress: (ab, pos) => {
      let temp = new ArrayBuffer(viewType.BYTES_PER_ELEMENT);
      let tempOutput = new Uint8Array(temp);
      let input = new Uint8Array(ab, pos);
      for (let i = 0; i < viewType.BYTES_PER_ELEMENT; i++)
        tempOutput[i] = input[i];
      let result = new viewType(temp);
      return [viewType.BYTES_PER_ELEMENT, String(result[0])];
    },
  };
}

// Generate an encoder which encodes a single word.
function generateWordEncoder(word) {
  return { // Dictionary.
    name: 'dict-' + word.substr(0, 3),
    compress: (str, ipos, ab, opos) => {
      if (!str.startsWith(word, ipos))
        return null;
      return [word.length, 0];
    },
    decompress: (ab, pos) => {
			return [0, word];
    },
  }
}

// An encoder for capitalized hex strings.
const HEX_ENCODER = { // Hex
  name: 'hex',
  compress: (str, ipos, ab, opos) => {
    let bytes = new Uint8Array(ab, opos);
    // Early exit, must at least have 2 hex values to be worth compressing.
    if (str.length < ipos + 4 || str[ipos + 2] != ':')
      return null;
    let consumed = 0;
    bytes[0] = 0;
    let colon = 0;
    while (str.length > ipos + consumed + 1 + colon) {
      if (colon && str[ipos + consumed] != ':')
        break;
      let piece = str.substr(ipos + consumed + colon, 2);
      let num = parseInt(piece, 16);
      if (num.toString(16).toUpperCase().padStart(2, '0') != piece)
        break;
      bytes[++bytes[0]] = num;
      consumed += 2 + colon; // Consume 2 bytes.
      colon = 1; // From now on, a colon must be consumed.
    }
    // Must produce at least 3 bytes to be worth encoding.
    if (consumed < 3)
      return null;
    return [consumed, bytes[0] + 1];
  },
  decompress: (ab, pos) => {
    let bytes = new Uint8Array(ab, pos);
    let count = bytes[0];
    let values = new Uint8Array(ab, pos + 1, count);
    return [count + 1, Array.prototype.slice.apply(values).map((value) => value.toString(16).toUpperCase().padStart(2, '0')).join(':')];
  },
};

// An encoder for IPv4 addresses.
const IPV4_ENCODER = { // IPv4 Address
  name: 'ipv4',
  compress: (str, ipos, ab, opos) => {
    let epos = ipos;
    let output = new Uint8Array(ab, opos, 4);
    let values = 0;
    let cur = ipos;
    while (str.length > epos && isDigit(str[epos])) {
      epos++;
      if (epos - cur > 3)
        return null;
      if (!isDigit(str[epos])) {
        let piece = str.substring(cur, epos);
        let val = parseInt(piece);
        if (val > 255 || piece != val.toString())
          return null;
        output[values++] = val;
        if (str[epos] == '.' && values < 4) {
          epos++;
          cur = epos;
          continue;
        }
        break;
      }
    }
    if (values < 4)
      return null;
    return [epos - ipos, 4];
  },
  decompress: (ab, pos) => {
    let values = new Uint8Array(ab, pos, 4);
    return [4, Array.prototype.slice.apply(values).map((value) => value.toString()).join('.')];
  },
};

let CODEPOINTS = [];
for (let i = 0; i < DICTIONARY.length; i++)
  CODEPOINTS.push(generateWordEncoder(DICTIONARY[i]));
CODEPOINTS.push(HEX_ENCODER);
CODEPOINTS.push(IPV4_ENCODER);
CODEPOINTS.push(generateNumberEncoder(Uint8Array));
CODEPOINTS.push(generateNumberEncoder(Uint16Array));
CODEPOINTS.push(generateNumberEncoder(Uint32Array, true));

function rtc_str_compress(str) {
	let output = new ArrayBuffer(str.length);
	let bytes = new Uint8Array(output);
	let opos = 0;
	for (let i = 0; i < str.length;) {
		// TODO: If this becomes a problem, encode used codepoints as another codepoint i.e. escape sequence.
		if (str.charCodeAt(i) >= FIRST_CODEPOINT && str.charCodeAt(i) < FIRST_CODEPOINT + CODEPOINTS.length)
			console.error('Custom codepoint exists in input, will be incorrectly decoded.');

		// Test for custom codepoint compression.
    let encoded = null;
		for (let j = 0; j < CODEPOINTS.length; j++) {
			// opos + 1 is used as the output, since opos will contain the current
      // codepoint if successful.
			encoded = CODEPOINTS[j].compress(str, i, output, opos + 1);
      if (encoded) {
        bytes[opos++] = FIRST_CODEPOINT + j;
        opos += encoded[1];
        i += encoded[0];
        break;
      }
		}
    if (!encoded)
      bytes[opos++] = str.charCodeAt(i++);
	}
	return output.slice(0, opos);
}

function rtc_str_decompress(ab, pos) {
	let output = '';
	let bytes = new Uint8Array(ab);
	for (let i = pos || 0; i < ab.byteLength;) {
    let j = bytes[i] - FIRST_CODEPOINT;
    if (j >= 0 && j < CODEPOINTS.length) {
      let result = CODEPOINTS[j].decompress(ab, ++i);
      i += result[0];
      output += result[1];
      continue;
    }

		output += String.fromCharCode(bytes[i++]);
	}
	return output;
}
