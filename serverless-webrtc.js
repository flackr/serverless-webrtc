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

const QUIET_PROFILE = 'ultrasonic';
function transmit(data) {
  return new Promise((accept, reject) => {
    quietReady.then(() => {
      let transmit = Quiet.transmitter({profile: QUIET_PROFILE, onFinish: accept});
      transmit.transmit(Quiet.str2ab(JSON.stringify(data)));
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
            let result = JSON.parse(Quiet.ab2str(content));
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
  console.log({offer, candidates});
  await transmit({offer, candidates});

  let answer = await receive();
  connection.setRemoteDescription(new RTCSessionDescription(answer.answer));
  for (let i = 0; i < answer.candidates.length; i++)
    connection.addIceCandidate(new RTCIceCandidate(answer.candidates[i]));
  return await connectPromise();
}

async function accept() {
  // Start listening for offer
  let offer = await receive();
  let connection = new RTCPeerConnection();
  let connectPromise = new Promise((acc, rej) => {
    connection.ondatachannel = (dc) => {
      accept(dc);
    };
  });
  let candidatesPromise = getIceCandidates(connection);
  connection.setRemoteDescription(new RTCSessionDescription(offer.offer));
  let answer = await connection.createAnswer();
  await connection.setLocalDescription(answer);
  for (let i = 0; i < offer.candidates.length; i++)
    connection.addIceCandidate(new RTCIceCandidate(offer.candidates[i]));

  let candidates = await candidatesPromise;
  await transmit({answer, candidates});

  return await connectPromise;
}
