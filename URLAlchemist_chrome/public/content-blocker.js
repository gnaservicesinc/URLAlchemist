(() => {
  const params = new URLSearchParams(window.location.search);
  const chromeApi = globalThis.chrome;

  async function loadPayload() {
    let payload = {
      mode: params.get('mode') || 'block',
      title: params.get('title') || 'Page blocked',
      message: params.get('message') || 'This page is blocked by URL Alchemist.',
      reason: params.get('reason') || '',
      packId: params.get('packId') || '',
      packName: params.get('packName') || 'URL Alchemist',
      sourceUrl: params.get('sourceUrl') || '',
      tasks: [],
      mediaDataUrl: '',
    };

    const id = params.get('id');
    if (id && chromeApi?.storage?.session) {
      const stored = await chromeApi.storage.session.get(id);
      if (stored[id] && typeof stored[id] === 'object') {
        payload = { ...payload, ...stored[id] };
      }
      await chromeApi.storage.session.remove(id);
    }
    return payload;
  }

  function taskShell(task) {
    const shell = document.createElement('section');
    shell.className = 'challenge-task';
    const title = document.createElement('h2');
    title.textContent = task.label || 'Challenge';
    shell.append(title);
    return shell;
  }

  function renderTimer(task, markComplete) {
    const shell = taskShell(task);
    const remaining = document.createElement('p');
    remaining.className = 'task-value';
    const seconds = Math.max(1, Math.trunc(task.seconds || 30));
    let left = seconds;
    remaining.textContent = `${left}s`;
    shell.append(remaining);
    const timer = window.setInterval(() => {
      left -= 1;
      remaining.textContent = `${Math.max(0, left)}s`;
      if (left <= 0) {
        window.clearInterval(timer);
        shell.classList.add('complete');
        markComplete();
      }
    }, 1000);
    return shell;
  }

  function renderTyper(task, markComplete) {
    const shell = taskShell(task);
    const text = String(task.text || 'I want to continue');
    const count = Math.max(1, Math.trunc(task.count || 1));
    const prompt = document.createElement('p');
    prompt.textContent = `Type "${text}" ${count} time${count === 1 ? '' : 's'}.`;
    const input = document.createElement('textarea');
    input.className = 'task-input';
    input.rows = 3;
    shell.append(prompt, input);
    input.addEventListener('input', () => {
      const matches = input.value
        .split(/\n+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry === text).length;
      if (matches >= count) {
        input.disabled = true;
        shell.classList.add('complete');
        markComplete();
      }
    });
    return shell;
  }

  function renderClicker(task, markComplete) {
    const shell = taskShell(task);
    const count = Math.max(1, Math.trunc(task.count || 10));
    let clicked = 0;
    const button = document.createElement('button');
    button.className = 'task-button';
    button.type = 'button';
    button.textContent = `Click ${count} times`;
    shell.append(button);
    button.addEventListener('click', () => {
      clicked += 1;
      button.textContent = `${Math.max(0, count - clicked)} remaining`;
      if (clicked >= count) {
        button.disabled = true;
        shell.classList.add('complete');
        markComplete();
      }
    });
    return shell;
  }

  function renderConfirm(task, markComplete) {
    const shell = taskShell(task);
    const text = document.createElement('p');
    text.textContent = String(task.text || 'Confirm that you want to continue.');
    const button = document.createElement('button');
    button.className = 'task-button';
    button.type = 'button';
    button.textContent = 'Confirm';
    shell.append(text, button);
    button.addEventListener('click', () => {
      button.disabled = true;
      shell.classList.add('complete');
      markComplete();
    });
    return shell;
  }

  function renderReason(task, markComplete) {
    const shell = taskShell(task);
    const text = document.createElement('p');
    text.textContent = String(task.text || 'Why do you want to continue?');
    const input = document.createElement('textarea');
    input.className = 'task-input';
    input.rows = 3;
    shell.append(text, input);
    input.addEventListener('input', () => {
      if (input.value.trim().length >= 8) {
        shell.classList.add('complete');
        markComplete();
      }
    });
    return shell;
  }

  function renderTask(task, markComplete) {
    switch (task.kind) {
      case 'timer':
        return renderTimer(task, markComplete);
      case 'typer':
        return renderTyper(task, markComplete);
      case 'clicker':
        return renderClicker(task, markComplete);
      case 'reason':
        return renderReason(task, markComplete);
      case 'confirm':
      default:
        return renderConfirm(task, markComplete);
    }
  }

  async function grantAndContinue(payload) {
    if (chromeApi?.runtime?.sendMessage && payload.packId && payload.sourceUrl) {
      await chromeApi.runtime.sendMessage({
        type: 'URL_ALCHEMIST_CONTENT_BLOCKER_CHALLENGE_COMPLETE',
        packId: payload.packId,
        sourceUrl: payload.sourceUrl,
      });
    }
    if (payload.sourceUrl) {
      window.location.href = payload.sourceUrl;
    }
  }

  async function main() {
    const payload = await loadPayload();
    document.title = payload.title;
    document.getElementById('guard-title').textContent = payload.title;
    document.getElementById('guard-message').textContent = payload.message;
    document.getElementById('pack-name').textContent = payload.packName;
    document.getElementById('source-url').textContent = payload.sourceUrl;

    const reason = document.getElementById('guard-reason');
    if (payload.reason) {
      reason.textContent = payload.reason;
      reason.hidden = false;
    }

    const image = document.getElementById('guard-media');
    if (payload.mediaDataUrl) {
      image.src = payload.mediaDataUrl;
      image.hidden = false;
    }

    const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    const taskList = document.getElementById('challenge-tasks');
    const continueButton = document.getElementById('continue-button');
    if (payload.mode !== 'challenge') {
      continueButton.hidden = true;
      return;
    }

    if (tasks.length === 0) {
      continueButton.disabled = false;
    } else {
      let completed = 0;
      const markComplete = () => {
        completed += 1;
        if (completed >= tasks.length) {
          continueButton.disabled = false;
        }
      };
      tasks.forEach((task) => {
        taskList.append(renderTask(task, markComplete));
      });
    }

    continueButton.addEventListener('click', () => {
      continueButton.disabled = true;
      void grantAndContinue(payload);
    });
  }

  void main();
})();
