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

const QUIET_PROFILE = 'audible';
function transmit(data) {
  return new Promise((accept, reject) => {
    quietReady.then(() => {
      let transmit = Quiet.transmitter({profile: QUIET_PROFILE, onFinish: accept});
      let uncompressed = JSON.stringify(data);
      let compressed = rtc_str_compress(uncompressed);
      console.info('Compressed ' + uncompressed.length + ' down to ' + compressed.byteLength + ' bytes.');
      transmit.transmit(compressed);
    });
  });
}

function receive() {
  return new Promise((accept, reject) => {
    quietReady.then(() => {
      let content = new ArrayBuffer();
      let finish = (data, err) => {
        receiver.destroy();
        if (err) {
          reject(err);
        } else {
          accept(data);
        }
      }
      let receiver = Quiet.receiver({profile: QUIET_PROFILE,
        onReceive: (payload) => {
          content = Quiet.mergeab(content, payload);
          try {
            let result = JSON.parse(rtc_str_decompress(content));
            finish(result);
          } catch (e) {
            console.log('Receiving data, not valid JSON yet');
          }
        },
        onCreateFail: (reason) => {
          finish(null, reason);
        },
        onReceiveFail: (num_fails) => {
          finish(null, 'Failed to receive data');
        },
      });
    });
  });
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
