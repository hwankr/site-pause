// This script is injected by the development server, never by the extension.
if (window.top === window) {
  const events = new EventSource('/__preview/events');
  events.onmessage = () => location.reload();
  window.addEventListener('pagehide', () => events.close(), {once: true});
} else {
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (link && new URL(link.href).origin === location.origin) link.target = '_self';
  }, true);
}
