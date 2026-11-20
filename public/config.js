// Generated at build time (see scripts/build.js). Shared by the page and the service worker.
self.__wp$config = {
  sjPrefix: "{{SJ_PREFIX}}",
  uvPrefix: "{{UV_PREFIX}}",
  // Keyed URL codec: proxied addresses look like /s/Qm9vb3... and can't be read or base64-decoded.
  encode: {{CODEC_ENCODE}},
  decode: {{CODEC_DECODE}},
  files: {
    scramjetAll: "{{scramjet.all.js}}",
    scramjetSync: "{{scramjet.sync.js}}",
    scramjetWasm: "{{scramjet.wasm}}",
    baremuxWorker: "{{baremux.worker.js}}",
    epoxy: "{{epoxy.mjs}}",
    libcurl: "{{libcurl.mjs}}",
  },
};
