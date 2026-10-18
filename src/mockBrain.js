'use strict';

// Mock brain used when no Meta Model API key is set.
// Replies are clearly labeled as mock. It also understands a few plain-English
// task requests so the approval-gate flow can be tried end to end offline,
// and it can review an imported "ChatGPT result" in a simple structured way.

const MOCK_LABEL = '[Mock mode — add your Meta Model API key in Settings for live Muse Spark]';

function actionsBlock(actions) {
  return '```actions\n' + JSON.stringify(actions, null, 2) + '\n```';
}

function mockReply(userText, homePath) {
  const text = (userText || '').trim();
  const lower = text.toLowerCase();

  // Imported ChatGPT result (renderer prefixes imported content).
  if (lower.startsWith('[chatgpt result') || lower.includes('chatgpt result for review')) {
    return [
      MOCK_LABEL,
      '',
      'Here is my structured review of that ChatGPT result (mock review — a live key gives a real one):',
      '- **What it claims:** (see the imported text above)',
      '- **Looks sound:** the structure and any claims that match the source files it cites.',
      '- **Needs checking:** any number, date, or name that is not backed by a cited source.',
      '- **Next step:** use "Package for ChatGPT" to send my questions back, or ask me to dig into a specific claim.'
    ].join('\n');
  }

  // list_folder: "list my downloads", "list folder C:\...", "what's in ~/Documents"
  const listMatch =
    text.match(/list(?:\s+the)?\s+(?:contents\s+of\s+)?([A-Za-z]:\\[^\s"']+|~[\\/][^\s"']+|\/[^\s"']+)/i) ||
    lower.match(/(downloads|documents|desktop) folder/);
  if (lower.startsWith('list') || lower.includes('what is in') || lower.includes("what's in")) {
    let folder = null;
    let label = 'List folder';
    if (listMatch) {
      if (listMatch[1] && (listMatch[1].includes('\\') || listMatch[1].includes('/'))) {
        folder = listMatch[1].replace(/^~/, homePath);
        label = `List ${folder}`;
      } else if (listMatch[1]) {
        const name = listMatch[1][0].toUpperCase() + listMatch[1].slice(1);
        folder = `${homePath}\\${name}`;
        label = `List my ${name} folder`;
      }
    }
    if (folder) {
      return `${MOCK_LABEL}\n\nI can do that. I've proposed one step below — nothing runs until you approve it.\n\n${actionsBlock([{ type: 'list_folder', path: folder, label }])}`;
    }
  }

  // Clipboard bridge: "copy from chatgpt" / "paste this to chatgpt: ..."
  if (lower.includes('copy from chatgpt') || lower.includes('copy from dot')) {
    return `${MOCK_LABEL}\n\nI'll grab the text from your ChatGPT window. This uses PowerShell + SendKeys on Windows and — like every task — only runs if you approve the step, which shows the exact target window.\n\n${actionsBlock([{ type: 'copy_from_app', targetTitle: 'ChatGPT', label: 'Copy all text from the ChatGPT window' }])}`;
  }
  const pasteMatch = text.match(/paste (?:this )?to chatgpt\s*:\s*([\s\S]+)$/i);
  if (pasteMatch) {
    const pasteText = pasteMatch[1].trim();
    return `${MOCK_LABEL}\n\nReady to paste into ChatGPT. The approval card shows the exact text and target window before anything happens.\n\n${actionsBlock([{ type: 'paste_to_app', targetTitle: 'ChatGPT', text: pasteText, label: 'Paste into the ChatGPT window' }])}`;
  }

  // open_url: "open https://..."
  const urlMatch = text.match(/https?:\/\/[^\s"']+/i);
  if (lower.includes('open') && urlMatch) {
    const url = urlMatch[0];
    return `${MOCK_LABEL}\n\nReady to open that link — approve the step below and it opens in your browser.\n\n${actionsBlock([{ type: 'open_url', url, label: `Open ${url}` }])}`;
  }

  // create_file: "create a file called notes.txt ..." (path defaults to home)
  const createMatch = text.match(/create a file(?: called)? ([^\s"']+\.(?:txt|md|json|csv))/i);
  if (createMatch) {
    const filePath = `${homePath}\\${createMatch[1]}`;
    return `${MOCK_LABEL}\n\nI'll create that file in your home folder. Approve the step below to run it.\n\n${actionsBlock([{ type: 'create_file', path: filePath, content: '', label: `Create ${createMatch[1]}` }])}`;
  }

  // run_command: "run command: ..." or "run: ..."
  const runMatch = text.match(/run(?:\s+command)?\s*:\s*(.+)$/i);
  if (runMatch) {
    const command = runMatch[1].trim();
    return `${MOCK_LABEL}\n\nHere is the exact command as a step. Read it carefully — it only runs if you approve it.\n\n${actionsBlock([{ type: 'run_command', command, label: `Run: ${command}` }])}`;
  }

  // Vault fills: "fill the login for GitHub" / "log in to GitHub" /
  // "enter the authenticator code for GitHub". The proposal references the
  // vault entry by LABEL only — mock mode never sees a real secret, and
  // neither does the live model.
  const totpMatch =
    text.match(/(?:authenticator|2fa|two[- ]factor|verification) code for (.+)$/i) ||
    text.match(/fill (?:the )?totp for (.+)$/i);
  if (totpMatch) {
    const entryLabel = totpMatch[1].trim().replace(/[."']+$/, '');
    return `${MOCK_LABEL}\n\nI'll type the current authenticator code from your vault entry "${entryLabel}". The approval card shows the entry and window — never the code. The code itself is generated in the app at the moment the step runs.\n\n${actionsBlock([{ type: 'fill_totp', entryLabel, label: `Fill authenticator code for ${entryLabel}` }])}`;
  }
  const fillMatch =
    text.match(/fill (?:the )?login for (.+)$/i) ||
    text.match(/log ?in to (.+)$/i) ||
    text.match(/sign in to (.+)$/i);
  if (fillMatch) {
    const entryLabel = fillMatch[1].trim().replace(/[."']+$/, '');
    return `${MOCK_LABEL}\n\nI'll fill the login from your vault entry "${entryLabel}". The approval card shows the site and username — never the password, which the app types straight from the vault.\n\n${actionsBlock([{ type: 'fill_login', entryLabel, label: `Fill login for ${entryLabel}` }])}`;
  }

  if (lower.includes('open') && (lower.includes('notepad') || lower.includes('calculator') || lower.includes('explorer'))) {
    const app = lower.includes('notepad') ? 'notepad' : lower.includes('calculator') ? 'calc' : 'explorer';
    return `${MOCK_LABEL}\n\nApprove the step below and I'll open it.\n\n${actionsBlock([{ type: 'open_app', name: app, label: `Open ${app}` }])}`;
  }

  return [
    MOCK_LABEL,
    '',
    `You said: "${text}"`,
    '',
    'In mock mode I can still demonstrate the task flow. Try one of these:',
    '- "list my Downloads folder"',
    '- "open https://example.com"',
    '- "create a file called notes.txt"',
    '- "run command: whoami"',
    '- "fill the login for <a vault entry label>" (unlock the Vault first)',
    '- "enter the authenticator code for <a vault entry label>"',
    '',
    'Or import a ChatGPT result from the Bridge panel and I will structure a review of it.',
    'Add your Meta Model API key in Settings and I become the real Muse Spark.'
  ].join('\n');
}

module.exports = { mockReply, MOCK_LABEL };
