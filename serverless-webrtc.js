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

function getIceCandidates(connection) {
  return new Promise((accept, reject) => {
    let candidates = [];
    function finish() {
      connection.onicecandidate = undefined;
      accept(candidates);
    }
    connection.onicecandidate = (e) => {
      if (e.candidate) {
        console.log('got candidate', e.candidate);
        candidates.push(e.candidate);
      } else {
        finish();
      }
    };
  });
}

let QUIET_PROFILE = 'audible';
const CHUNK_SIZE = 100;
function transmitRaw(ab) {
  return new Promise((accept, reject) => {
    quietReady.then(() => {
      let transmitter = Quiet.transmitter({profile: QUIET_PROFILE, onFinish: accept});
      let view = new Uint8Array(ab);
      console.log('transmitting ' + ab.byteLength + ' bytes [' + view[0] + ', ' + view[1] + ', ' + view[2] + ', ' + view[3] + '...]');
      transmitter.transmit(ab);
    });
  });
}

const LONG_TIMEOUT = 500000;
const TIMEOUT = 5000;
async function transmit(data) {
  let uncompressed = JSON.stringify(data);
  let compressed = rtc_str_compress(uncompressed);
  console.info('Compressed ' + uncompressed.length + ' down to ' + compressed.byteLength + ' bytes.');
  let chunks = Math.ceil(compressed.byteLength / CHUNK_SIZE);
  let description = new ArrayBuffer(6);
  let bytes = new Uint8Array(description);
  bytes[0] = bytes[1] = bytes[2] = chunks;
  bytes[3] = bytes[4] = bytes[5] = compressed.byteLength % CHUNK_SIZE;
  let success = false;
  while (!success) {
    await transmitRaw(description);
    try {
      response = new Uint8Array(await receiveRaw(0, TIMEOUT * 2.5));
      success = response[0];
    } catch (e) {}
    if (!success) {
      console.warn('Retransmitting header');
    }
  }
  for (let i = 0; i < chunks; i++) {
    console.log('sending chunk ' + i);
    await transmitRaw(compressed.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
    let response = null;
    while (!response) {
      try {
        response = new Uint8Array(await receiveRaw(0, LONG_TIMEOUT));
      } catch (e) {}
    }
    if (response[0] <= i + 1) {
      console.warn('Retransmitting ' + i);
      chunks--;
    }
  }
  console.log('All ' + chunks + ' chunks sent');
}

function receiveRaw(minBytes, timeout) {
  return new Promise((accept, reject) => {
    quietReady.then(() => {
      let content = new ArrayBuffer();
      let timer;
      let finished = false;
      let receiver;
      let finish = (data, err) => {
        clearTimeout(timer);
        receiver.destroy();
        if (err) {
          reject(err);
        } else {
          accept(data);
        }
      }

      function timeoutfn() {
        finish(null, 'Timeout');
      }

      console.log('awaiting ' + minBytes + ' bytes');
      receiver = Quiet.receiver({profile: QUIET_PROFILE,
        onReceive: (payload) => {
          if (finished)
            return;
          clearTimeout(timer);
          content = Quiet.mergeab(content, payload);
          console.log('Got ' + content.byteLength + ' bytes');
          if (content.byteLength >= minBytes) {
            finished = true;
            finish(content);
          } else {
            timer = setTimeout(timeoutfn, timeout);
          }
        },
        onCreateFail: (reason) => {
          finish(null, reason);
        },
        onReceiveFail: (num_fails) => {
          finish(null, 'Failed to receive data');
        },
      });
      timer = setTimeout(timeoutfn, timeout);
    });
  });
}

async function ack(value) {
  let buffer = new ArrayBuffer(3);
  let bytes = new Uint8Array(buffer);
  bytes[0] = bytes[1] = bytes[2] = value;
  await transmitRaw(buffer);
}

async function receive() {
  // First receive the handshake
  let header = null;
  while (!header) {
    try {
      header = await receiveRaw(6, LONG_TIMEOUT);
    } catch (e) {}
  }
  let headerBytes = new Uint8Array(header);
  await ack(1);

  // Now recieve the chunks
  let chunks = headerBytes[0];
  let lastSize = headerBytes[3];
  let ab = new ArrayBuffer(0);
  for (let i = 0; i < chunks; i++) {
    console.log('awaiting chunk ' + i);
    let expectedSize = i == chunks - 1 ? lastSize : CHUNK_SIZE;
    let received = null;
    while (!received) {
      try {
        received = await receiveRaw(expectedSize, TIMEOUT);
        await ack(i + 2);
      } catch (e) {
        console.warn('Requesting retransmission of ' + i);
        await ack(i + 1);
      }
    }
    console.log('received chunk ' + i);
    ab = Quiet.mergeab(ab, received);
  }
  console.log('All ' + chunks + ' chunks received');
  // TODO: There's a risk that the sender didn't receive the last ack. We
  // could try to confirm it but the same problem would exist in the other
  // direction ¯\_(ツ)_/¯
  return JSON.parse(rtc_str_decompress(ab));
}

Quiet.init({
  profilesPrefix: "third_party/quiet-js/",
  memoryInitializerPrefix: "third_party/quiet-js/",
  libfecPrefix: "third_party/quiet-js/"
});
let quietReady = new Promise((accept, reject) => {
  Quiet.addReadyCallback(accept, reject);
});

async function connect() {
  let connection = new RTCPeerConnection();
  let dataChannel = connection.createDataChannel("data");
  let connectPromise = new Promise((accept, reject) => {
    dataChannel.onopen = function() {
      accept(dataChannel);
    }
  });

  // Begin announcing offer.
  let offer = await connection.createOffer();
  connection.setLocalDescription(offer);
  let candidates = await getIceCandidates(connection);
  console.log('Announcing offer');
  await transmit([offer, candidates]);

  console.log('Awaiting answer');
  let answer = await receive();
  connection.setRemoteDescription(new RTCSessionDescription(answer[0]));
  for (let i = 0; i < answer[1].length; i++)
    connection.addIceCandidate(new RTCIceCandidate(answer[1][i]));
  return await connectPromise;
}

async function accept() {
  // Start listening for offer
  console.log('Awaiting offer');
  let offer = await receive();
  let connection = new RTCPeerConnection();
  let connectPromise = new Promise((acc, rej) => {
    connection.ondatachannel = (evt) => {
      evt.channel.onopen = () => {
        acc(evt.channel);
      };
    };
  });
  let candidatesPromise = getIceCandidates(connection);
  connection.setRemoteDescription(new RTCSessionDescription(offer[0]));
  let answer = await connection.createAnswer();
  await connection.setLocalDescription(answer);
  for (let i = 0; i < offer[1].length; i++)
    connection.addIceCandidate(new RTCIceCandidate(offer[1][i]));

  let candidates = await candidatesPromise;
  console.log('Announcing answer');
  await transmit([answer, candidates]);

  return await connectPromise;
}
