(async () => {
  const params = new URLSearchParams(window.location.search);
  let payload = {
    title: params.get('title') || 'Focus Guard',
    message: params.get('message') || 'This page is blocked by URL Alchemist.',
    packName: params.get('packName') || 'URL Alchemist',
    sourceUrl: params.get('sourceUrl') || '',
    mediaDataUrl: '',
  };

  const id = params.get('id');
  const chromeApi = globalThis.chrome;
  if (id && chromeApi?.storage?.session) {
    const stored = await chromeApi.storage.session.get(id);
    if (stored[id] && typeof stored[id] === 'object') {
      payload = { ...payload, ...stored[id] };
    }
    await chromeApi.storage.session.remove(id);
  }

  document.title = payload.title;
  document.getElementById('guard-title').textContent = payload.title;
  document.getElementById('guard-message').textContent = payload.message;
  document.getElementById('pack-name').textContent = payload.packName;
  document.getElementById('source-url').textContent = payload.sourceUrl;

  const image = document.getElementById('guard-media');
  if (payload.mediaDataUrl) {
    image.src = payload.mediaDataUrl;
    image.hidden = false;
  }
})();
