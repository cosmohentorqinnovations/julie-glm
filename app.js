/* ============================================================
   JULIE AI — Chat App Logic
   ============================================================ */

// --- Config (loaded from config.js or env-injected __JULIE_CONFIG__) ---
const CFG = (() => {
  if (window.JULIE_CONFIG) return window.JULIE_CONFIG;
  return {
    GLM_BASE_URL: "__GLM_BASE_URL__",
    GLM_MODEL:    "__GLM_MODEL__",
    GLM_API_KEY:  "__GLM_API_KEY__",
  };
})();

// --- DOM refs ---
const canvas         = document.getElementById('particleCanvas');
const cursor         = document.querySelector('.cursor');
const cursorFollower = document.querySelector('.cursor-follower');
const navbar         = document.getElementById('navbar');
const welcomeState   = document.getElementById('welcomeState');
const messagesArea   = document.getElementById('messagesArea');
const messageInput   = document.getElementById('messageInput');
const sendBtn        = document.getElementById('sendBtn');
const clearBtn       = document.getElementById('clearBtn');
const charCount      = document.getElementById('charCount');

// --- State ---
let messages = [];       // { role, content }
let isStreaming = false;

// ============================================================
// PARTICLE CANVAS
// ============================================================
(function initParticles() {
  const ctx = canvas.getContext('2d');
  let W, H, particles = [];

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function spawn() {
    return {
      x: Math.random() * W,
      y: Math.random() * H,
      r: Math.random() * 1.2 + 0.2,
      a: Math.random() * 0.5 + 0.1,
      dx: (Math.random() - 0.5) * 0.15,
      dy: (Math.random() - 0.5) * 0.15,
    };
  }

  function init() {
    resize();
    particles = Array.from({ length: 90 }, spawn);
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    particles.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${p.a})`;
      ctx.fill();
      p.x += p.dx; p.y += p.dy;
      if (p.x < 0 || p.x > W || p.y < 0 || p.y > H) Object.assign(p, spawn());
    });
    requestAnimationFrame(draw);
  }

  window.addEventListener('resize', resize);
  init();
  draw();
})();

// ============================================================
// CUSTOM CURSOR
// ============================================================
document.addEventListener('mousemove', e => {
  cursor.style.left = e.clientX + 'px';
  cursor.style.top  = e.clientY + 'px';
  setTimeout(() => {
    cursorFollower.style.left = e.clientX + 'px';
    cursorFollower.style.top  = e.clientY + 'px';
  }, 80);
});

document.addEventListener('mouseover', e => {
  if (e.target.matches('button,a,.suggestion-chip,.thinking-block,.btn-icon')) {
    cursor.classList.add('hover');
    cursorFollower.classList.add('hover');
  }
});
document.addEventListener('mouseout', () => {
  cursor.classList.remove('hover');
  cursorFollower.classList.remove('hover');
});

// ============================================================
// NAVBAR SCROLL
// ============================================================
document.querySelector('.chat-main').addEventListener('scroll', function () {
  navbar.classList.toggle('scrolled', this.scrollTop > 10);
});

// ============================================================
// REVEAL ANIMATION
// ============================================================
const revealEls = document.querySelectorAll('.reveal');
const revealObs = new IntersectionObserver(entries => {
  entries.forEach(e => e.isIntersecting && e.target.classList.add('visible'));
}, { threshold: 0.1 });
revealEls.forEach(el => revealObs.observe(el));
// Trigger welcome block
setTimeout(() => revealEls.forEach(el => el.classList.add('visible')), 100);

// ============================================================
// INPUT AUTO-RESIZE & ENABLE SEND
// ============================================================
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 160) + 'px';
  const len = messageInput.value.length;
  sendBtn.disabled = !len || isStreaming;
  charCount.textContent = len > 100 ? `${len}/8000` : '';
});

messageInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) sendMessage();
  }
});

sendBtn.addEventListener('click', sendMessage);
clearBtn.addEventListener('click', clearConversation);

// Suggestion chips
document.querySelectorAll('.suggestion-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    messageInput.value = chip.dataset.prompt;
    messageInput.dispatchEvent(new Event('input'));
    sendMessage();
  });
});

// ============================================================
// SEND MESSAGE
// ============================================================
async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || isStreaming) return;

  messageInput.value = '';
  messageInput.style.height = 'auto';
  sendBtn.disabled = true;
  charCount.textContent = '';

  // Hide welcome, show messages
  if (welcomeState.style.display !== 'none') {
    welcomeState.style.display = 'none';
  }

  messages.push({ role: 'user', content: text });
  appendUserMessage(text);
  scrollToBottom();

  await streamAssistantReply();
}

// ============================================================
// STREAM ASSISTANT REPLY
// ============================================================
async function streamAssistantReply() {
  isStreaming = true;
  setSendLoading(true);

  const typingRow = appendTypingIndicator();
  scrollToBottom();

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (CFG.GLM_API_KEY) headers['Authorization'] = `Bearer ${CFG.GLM_API_KEY}`;

    const res = await fetch(`${CFG.GLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: CFG.GLM_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You are JULIE, an intelligent AI assistant created by CosmoHentorq Innovations Pvt. Ltd. You are helpful, concise, and professional. CosmoHentorq is a Startup India and Startup TN recognized IT company from Chennai, India, pioneering AI, Cloud, and Robotics.'
          },
          ...messages
        ],
        stream: true,
        max_tokens: 4096,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`API error ${res.status}: ${errText}`);
    }

    typingRow.remove();

    let thinkingContent = '';
    let replyContent    = '';
    let currentRow      = null;
    let thinkingBlock   = null;
    let bubbleEl        = null;
    let inThinking      = false;

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break;

        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }

        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        // Initialize message row on first token
        if (!currentRow) {
          currentRow = createAssistantRow();
          messagesArea.appendChild(currentRow);
          bubbleEl = currentRow.querySelector('.julie-bubble');
        }

        // Handle reasoning (thinking) content
        if (delta.reasoning !== undefined && delta.reasoning !== null) {
          inThinking = true;
          thinkingContent += delta.reasoning;
          if (!thinkingBlock) {
            thinkingBlock = createThinkingBlock();
            currentRow.querySelector('.msg-content').insertBefore(thinkingBlock, bubbleEl.parentElement?.previousSibling || bubbleEl);
          }
          thinkingBlock.querySelector('.thinking-body').textContent = thinkingContent;
        }

        // Handle actual content
        if (delta.content) {
          inThinking = false;
          replyContent += delta.content;
          bubbleEl.innerHTML = markdownToHTML(replyContent);
          scrollToBottom();
        }
      }
    }

    // Finalize
    if (currentRow) {
      if (!replyContent && thinkingContent) {
        // Model only returned reasoning — surface it as content
        replyContent = thinkingContent;
        bubbleEl.innerHTML = markdownToHTML(replyContent);
      }
      messages.push({ role: 'assistant', content: replyContent });
    }

  } catch (err) {
    typingRow?.remove();
    appendErrorMessage(err.message);
    console.error('[JULIE]', err);
  } finally {
    isStreaming = false;
    setSendLoading(false);
    sendBtn.disabled = !messageInput.value.trim();
    scrollToBottom();
  }
}

// ============================================================
// DOM HELPERS
// ============================================================
function appendUserMessage(text) {
  const row = document.createElement('div');
  row.className = 'message-row user';
  row.innerHTML = `
    <div class="msg-avatar user-av">YOU</div>
    <div class="msg-content">
      <span class="msg-name">You</span>
      <div class="msg-bubble user-bubble">${escapeHTML(text).replace(/\n/g, '<br>')}</div>
    </div>`;
  messagesArea.appendChild(row);
}

function createAssistantRow() {
  const row = document.createElement('div');
  row.className = 'message-row';
  row.innerHTML = `
    <div class="msg-avatar julie">J</div>
    <div class="msg-content">
      <span class="msg-name">JULIE</span>
      <div class="msg-bubble julie-bubble"></div>
    </div>`;
  return row;
}

function createThinkingBlock() {
  const block = document.createElement('div');
  block.className = 'thinking-block';
  block.innerHTML = `
    <div class="thinking-header">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>
      </svg>
      Thinking…
      <span class="thinking-toggle">▸ show</span>
    </div>
    <div class="thinking-body"></div>`;
  block.addEventListener('click', () => {
    block.classList.toggle('open');
    block.querySelector('.thinking-toggle').textContent =
      block.classList.contains('open') ? '▾ hide' : '▸ show';
  });
  return block;
}

function appendTypingIndicator() {
  const row = document.createElement('div');
  row.className = 'message-row';
  row.innerHTML = `
    <div class="msg-avatar julie">J</div>
    <div class="msg-content">
      <div class="typing-indicator">
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
      </div>
    </div>`;
  messagesArea.appendChild(row);
  return row;
}

function appendErrorMessage(msg) {
  const row = document.createElement('div');
  row.className = 'message-row';
  row.innerHTML = `
    <div class="msg-avatar julie">J</div>
    <div class="msg-content">
      <span class="msg-name">JULIE</span>
      <div class="msg-bubble julie-bubble error-bubble">⚠ ${escapeHTML(msg)}</div>
    </div>`;
  messagesArea.appendChild(row);
}

function clearConversation() {
  messages = [];
  messagesArea.innerHTML = '';
  welcomeState.style.display = '';
  setTimeout(() => {
    document.querySelectorAll('.reveal').forEach(el => el.classList.add('visible'));
  }, 50);
}

function setSendLoading(on) {
  if (on) {
    sendBtn.classList.add('loading');
    sendBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
  } else {
    sendBtn.classList.remove('loading');
    sendBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M22 2L11 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
}

function scrollToBottom() {
  const main = document.querySelector('.chat-main');
  main.scrollTo({ top: main.scrollHeight, behavior: 'smooth' });
}

// ============================================================
// SIMPLE MARKDOWN RENDERER
// ============================================================
function markdownToHTML(md) {
  let html = escapeHTML(md);

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code class="language-${lang}">${code.trim()}</code></pre>`
  );

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Heading 3
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  // Heading 2
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  // Heading 1
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Blockquote
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Unordered list
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, s => `<ul>${s}</ul>`);

  // Ordered list
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Horizontal rule
  html = html.replace(/^---$/gm, '<hr>');

  // Paragraphs (double newline)
  html = html.replace(/\n\n/g, '</p><p>');

  // Single line breaks
  html = html.replace(/\n/g, '<br>');

  // Wrap in paragraph
  if (!html.startsWith('<')) html = `<p>${html}</p>`;

  return html;
}

function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
