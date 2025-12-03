import osc from 'osc';

const udpPort = new osc.UDPPort({
  localAddress: '0.0.0.0',
  localPort: 57120,  // Same port SuperDirt listens on
});

udpPort.on('message', (msg) => {
  console.log('\n=== OSC MESSAGE ===');
  console.log('Address:', msg.address);
  
  // Parse args into key-value pairs
  const args = msg.args || [];
  const params = {};
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] && args[i+1] !== undefined) {
      params[args[i]] = args[i+1];
    }
  }
  
  // Show key params
  console.log('s:', params.s);
  console.log('n:', params.n);
  console.log('speed:', params.speed);
  console.log('note:', params.note);
  console.log('midinote:', params.midinote);
  console.log('freq:', params.freq);
  console.log('---');
});

udpPort.on('ready', () => {
  console.log('OSC Sniffer listening on port 57120');
  console.log('Press Ctrl+C to stop\n');
});

udpPort.on('error', (e) => {
  console.error('Error:', e.message);
});

udpPort.open();
