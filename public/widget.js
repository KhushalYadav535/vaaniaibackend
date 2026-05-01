/**
 * VaaniAI Embeddable Widget Script
 * 
 * Usage: Add this to any website:
 * <script>
 *   window.vaaniConfig = {
 *     agentId: "YOUR_AGENT_ID",
 *     color: "#8b5cf6",
 *     text: "Talk to AI",
 *     position: "bottom-right"
 *   };
 * </script>
 * <script src="https://YOUR_BACKEND/widget.js" async defer></script>
 */
(function () {
  'use strict';

  var config = window.vaaniConfig || {};
  var agentId = config.agentId;
  if (!agentId) {
    console.error('[VaaniAI Widget] Missing agentId in window.vaaniConfig');
    return;
  }

  var color = config.color || '#8b5cf6';
  var text = config.text || 'Talk to AI';
  var position = config.position || 'bottom-right';
  // Derive the backend origin from the script src
  var scripts = document.getElementsByTagName('script');
  var backendOrigin = '';
  for (var i = 0; i < scripts.length; i++) {
    if (scripts[i].src && scripts[i].src.indexOf('widget.js') !== -1) {
      var url = new URL(scripts[i].src);
      backendOrigin = url.origin;
      break;
    }
  }
  if (!backendOrigin) {
    backendOrigin = 'http://localhost:5000';
  }

  var frontendOrigin = config.frontendUrl || backendOrigin.replace(':5000', ':3000');

  // ─── Create Styles ───
  var style = document.createElement('style');
  style.textContent = [
    '.vaani-widget-btn{',
    '  position:fixed;',
    '  ' + (position === 'bottom-left' ? 'left' : 'right') + ':20px;',
    '  bottom:20px;',
    '  z-index:999999;',
    '  display:flex;align-items:center;gap:8px;',
    '  padding:14px 24px;',
    '  border:none;border-radius:50px;',
    '  background:' + color + ';',
    '  color:#fff;',
    '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
    '  font-size:14px;font-weight:600;',
    '  cursor:pointer;',
    '  box-shadow:0 4px 24px rgba(0,0,0,0.18);',
    '  transition:all 0.3s ease;',
    '}',
    '.vaani-widget-btn:hover{',
    '  transform:scale(1.05);',
    '  box-shadow:0 6px 32px rgba(0,0,0,0.25);',
    '}',
    '.vaani-widget-btn svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}',
    '.vaani-widget-popup{',
    '  position:fixed;',
    '  ' + (position === 'bottom-left' ? 'left' : 'right') + ':20px;',
    '  bottom:90px;',
    '  z-index:999998;',
    '  width:380px;height:520px;',
    '  border-radius:20px;',
    '  overflow:hidden;',
    '  box-shadow:0 12px 48px rgba(0,0,0,0.25);',
    '  border:1px solid rgba(0,0,0,0.08);',
    '  background:#fff;',
    '  display:none;',
    '  animation:vaani-slide-up 0.35s ease;',
    '}',
    '.vaani-widget-popup.vaani-open{display:block;}',
    '.vaani-widget-popup iframe{width:100%;height:100%;border:none;}',
    '@keyframes vaani-slide-up{',
    '  from{opacity:0;transform:translateY(20px);}',
    '  to{opacity:1;transform:translateY(0);}',
    '}',
    '@media(max-width:480px){',
    '  .vaani-widget-popup{',
    '    width:calc(100vw - 20px);',
    '    height:calc(100vh - 120px);',
    '    ' + (position === 'bottom-left' ? 'left' : 'right') + ':10px;',
    '    bottom:80px;border-radius:16px;',
    '  }',
    '}',
  ].join('\n');
  document.head.appendChild(style);

  // ─── Create Button ───
  var btn = document.createElement('button');
  btn.className = 'vaani-widget-btn';
  btn.innerHTML =
    '<svg viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>' +
    '<span>' + text + '</span>';
  document.body.appendChild(btn);

  // ─── Create Popup ───
  var popup = document.createElement('div');
  popup.className = 'vaani-widget-popup';

  var widgetUrl =
    frontendOrigin +
    '/widget?agentId=' + encodeURIComponent(agentId) +
    '&color=' + encodeURIComponent(color) +
    '&mode=embed' +
    '&backend=' + encodeURIComponent(backendOrigin);

  popup.innerHTML = '<iframe src="' + widgetUrl + '" allow="microphone;autoplay" sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe>';
  document.body.appendChild(popup);

  var isOpen = false;

  btn.addEventListener('click', function () {
    isOpen = !isOpen;
    if (isOpen) {
      popup.classList.add('vaani-open');
      btn.innerHTML =
        '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '<span>Close</span>';
    } else {
      popup.classList.remove('vaani-open');
      btn.innerHTML =
        '<svg viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>' +
        '<span>' + text + '</span>';
    }
  });

  // Listen for messages from iframe
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'vaani-close') {
      isOpen = false;
      popup.classList.remove('vaani-open');
      btn.innerHTML =
        '<svg viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>' +
        '<span>' + text + '</span>';
    }
  });
})();
