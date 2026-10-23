import { mountShell, readSelectedPaper, listenToText, stopSpeech as stopSharedSpeech } from '/static/js/core.js?v=github-2';

// Kept independent of the DOM so malformed model responses and saved progress
// can be checked without invoking the AI service.
export function normalizeCards(raw) {
  let value = raw;
  for (let depth = 0; depth < 3 && value && !Array.isArray(value) && typeof value === 'object' && 'flashcards' in value; depth++) value = value.flashcards;
  const list = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
  return list.slice(0, 30).flatMap(card => {
    if (!card || typeof card !== 'object' || Array.isArray(card)) return [];
    let title, content;
    if (typeof card.content === 'string') {
      title = typeof card.topic === 'string' ? card.topic : card.title;
      content = card.content;
    } else {
      if ('title' in card || 'topic' in card || 'content' in card) return [];
      const entries = Object.entries(card).filter(([key, text]) => typeof text === 'string' && key.trim() && text.trim());
      if (entries.length !== 1) return [];
      [title, content] = entries[0];
    }
    return typeof title === 'string' && title.trim() && content.trim() ? [{ title: title.trim().slice(0, 300), content: content.trim().slice(0, 16000) }] : [];
  });
}

export function normalizeQuestions(raw) {
  let value = raw;
  for (let depth = 0; depth < 3 && value && !Array.isArray(value) && typeof value === 'object' && 'questions' in value; depth++) value = value.questions;
  const list = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
  return list.slice(0, 30).flatMap(question => {
    if (!question || typeof question.question !== 'string' || !question.question.trim()) return [];
    const rawOptions = question.options;
    const options = Array.isArray(rawOptions) ? rawOptions : rawOptions && typeof rawOptions === 'object' ? Object.values(rawOptions) : [];
    if (options.length !== 4 || options.some(text => typeof text !== 'string' || !text.trim())) return [];
    const cleanOptions = options.map(text => text.trim().slice(0, 4000));
    if (new Set(cleanOptions.map(text => text.toLowerCase())).size !== 4) return [];
    let answer = question.answer;
    if (typeof answer === 'string') {
      const clean = answer.trim();
      if (/^[0-3]$/.test(clean)) answer = Number(clean);
      else if (/^[A-D]$/i.test(clean)) answer = clean.toUpperCase().charCodeAt(0) - 65;
      else answer = cleanOptions.indexOf(clean);
    }
    if (!Number.isInteger(answer) || answer < 0 || answer > 3) return [];
    return [{ question: question.question.trim().slice(0, 2000), options: cleanOptions.map(text => text.slice(0, 4000)), answer, explanation: typeof question.explanation === 'string' ? question.explanation.trim().slice(0, 6000) : '' }];
  });
}

export function safePdf(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(url.hostname) || url.port || url.username || url.password) return '';
    const path = url.pathname.match(/^\/(?:pdf|abs)\/((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)(?:\.pdf)?\/?$/i);
    return path ? 'https://arxiv.org/pdf/' + path[1] : '';
  } catch { return ''; }
}

export function summarizeAnswers(questions, answers) {
  return questions.reduce((summary, question, index) => {
    const answer = answers && answers[index];
    if (Number.isInteger(answer) && answer >= 0 && answer < question.options.length) {
      summary.answered++;
      if (answer === question.answer) summary.correct++;
    }
    return summary;
  }, { answered: 0, correct: 0, total: questions.length });
}

export function contentSignature(cards, questions) {
  const text = JSON.stringify([cards, questions]);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36) + ':' + text.length;
}

export function restoreProgress(saved, cards, questions) {
  const fresh = { activeIdea: 0, activeQuestion: 0, answers: {}, visited: cards.length ? [0] : [], tab: cards.length ? 'ideas' : 'quiz' };
  if (!saved || saved.signature !== contentSignature(cards, questions)) return fresh;
  if (Number.isInteger(saved.activeIdea) && saved.activeIdea >= 0 && saved.activeIdea < cards.length) fresh.activeIdea = saved.activeIdea;
  if (Number.isInteger(saved.activeQuestion) && saved.activeQuestion >= 0 && saved.activeQuestion < questions.length) fresh.activeQuestion = saved.activeQuestion;
  questions.forEach((question, index) => {
    const answer = saved.answers?.[index];
    if (Number.isInteger(answer) && answer >= 0 && answer < question.options.length) fresh.answers[index] = answer;
  });
  if (Array.isArray(saved.visited)) fresh.visited = [...new Set(saved.visited.filter(index => Number.isInteger(index) && index >= 0 && index < cards.length))];
  if (cards.length && !fresh.visited.includes(fresh.activeIdea)) fresh.visited.push(fresh.activeIdea);
  if (saved.tab === 'quiz' && questions.length) fresh.tab = 'quiz';
  return fresh;
}

if (typeof document !== 'undefined') initializeQuest();

function initializeQuest() {
  mountShell();
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const exampleRequested = params.get('demo') === 'attention';
  const pdf = safePdf(params.get('pdf') || '');
  let storageKey = 'easyarxiv:web:quest:v1:' + (exampleRequested ? 'demo:attention' : pdf);
  let cards = [], questions = [], answers = {}, visited = new Set();
  let activeIdea = 0, activeQuestion = 0, tab = 'ideas', selectedAnswer = null;
  let completedView = false, isExample = false, requiresSignIn = false;
  let controller = null, requestId = 0, requestTimeout = null;
  let selectedPaper = null;
  try { selectedPaper = readSelectedPaper(); } catch { /* The URL remains usable without storage. */ }
  const matchingPaper = selectedPaper && safePdf(selectedPaper.pdf_url || selectedPaper.pdf || '') === pdf ? selectedPaper : null;
  const initialTitle = params.get('title') || matchingPaper?.title || (exampleRequested ? 'Attention Is All You Need' : 'Research paper');
  const query = params.get('q') || '';
  let back = query ? '/papers?q=' + encodeURIComponent(query) : '/papers';
  try {
    const previousSearch = sessionStorage.getItem('easy-arxiv-web:lastQuery');
    if (!query && previousSearch?.startsWith('?')) back = '/papers' + previousSearch;
  } catch { /* Optional search context. */ }
  $('backToPapers').href = back; $('stateBack').href = back;
  setPaperContext(initialTitle, matchingPaper?.authors, matchingPaper?.published, pdf);

  function persist() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ signature: contentSignature(cards, questions), activeIdea, activeQuestion, answers, visited: [...visited], tab }));
    } catch { /* Reading and questions work when browser storage is full or blocked. */ }
  }

  function setPaperContext(title, authors, published, originalPdf) {
    $('paperTitle').textContent = title || 'Research paper';
    document.title = `${title || 'Your paper'} · AI Quest · Easy ArXiv`;
    const names = Array.isArray(authors) ? authors.map(author => typeof author === 'string' ? author : author?.name || '').filter(Boolean) : typeof authors === 'string' ? [authors] : [];
    const year = typeof published === 'string' && /^\d{4}/.test(published) ? published.slice(0, 4) : '';
    $('paperAuthors').textContent = (names.length ? names.slice(0, 2).join(', ') + (names.length > 2 ? ', et al.' : '') : '') + (year ? (names.length ? ' · ' : '') + year : '');
    $('paperAuthors').hidden = !$('paperAuthors').textContent;
    $('paperPdf').hidden = !originalPdf;
    if (originalPdf) $('paperPdf').href = originalPdf;
  }

  function stopSpeech() {
    stopSharedSpeech();
    $('listenButton').setAttribute('aria-pressed','false');
  }

  function showState(kind, title, description) {
    stopSpeech();
    requiresSignIn = kind === 'signin';
    $('questState').hidden = false;
    $('questWorkspace').hidden = true; $('questTabs').hidden = true;
    $('stateTitle').textContent = title;
    $('stateDescription').textContent = description;
    $('stateIcon').replaceChildren();
    if (kind === 'loading') {
      const spinner = document.createElement('span'); spinner.className = 'quest-spinner'; $('stateIcon').append(spinner);
    } else $('stateIcon').textContent = kind === 'error' ? '↻' : '↗';
    $('retryButton').hidden = !(requiresSignIn || (kind === 'error' && pdf));
    $('retryButton').textContent = requiresSignIn ? 'Continue with ORCID' : 'Try again';
    $('exampleButton').hidden = kind === 'loading' || !window.EasyArxivPapers?.attentionQuest;
    $('cancelButton').hidden = kind !== 'loading';
    $('statePdf').hidden = kind === 'loading' || !pdf;
    if (pdf) $('statePdf').href = pdf;
  }

  function renderTopics() {
    $('topicList').replaceChildren(); $('topicSelect').replaceChildren();
    cards.forEach((card, index) => {
      const li = document.createElement('li');
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'quest-topic-button' + (visited.has(index) ? ' quest-topic-read' : '');
      if (index === activeIdea) button.setAttribute('aria-current', 'step');
      const number = document.createElement('span'); number.className = 'quest-topic-number'; number.setAttribute('aria-hidden', 'true'); number.textContent = String(index + 1).padStart(2, '0');
      const title = document.createElement('span'); title.textContent = card.title;
      button.append(number, title); button.addEventListener('click', () => goToIdea(index, true));
      li.append(button); $('topicList').append(li);
      const option = document.createElement('option'); option.value = String(index); option.textContent = `${index + 1}. ${card.title}`; $('topicSelect').append(option);
    });
    $('topicSelect').value = String(activeIdea);
    $('ideaCount').textContent = String(cards.length);
  }

  function renderConcept() {
    const figure = $('ideaDiagram'); figure.replaceChildren();
    const concepts = {
      0: [['Tokens', 'A sequence of inputs'], ['Attention', 'Connect information'], ['Representations', 'Ready for the next layer']],
      2: [['Query', 'What am I looking for?'], ['Keys', 'What matches the query?'], ['Values', 'Combine using the weights']]
    };
    const steps = isExample ? concepts[activeIdea] : null;
    figure.hidden = !steps;
    if (!steps) return;
    const grid = document.createElement('div'); grid.className = 'quest-concept-grid';
    steps.forEach((step, index) => {
      if (index) { const arrow = document.createElement('span'); arrow.className = 'quest-concept-arrow'; arrow.setAttribute('aria-hidden', 'true'); arrow.textContent = '→'; grid.append(arrow); }
      const cell = document.createElement('div'); cell.className = 'quest-concept-step';
      const label = document.createElement('strong'); label.textContent = step[0]; const note = document.createElement('span'); note.textContent = step[1];
      cell.append(label, note); grid.append(cell);
    });
    const caption = document.createElement('figcaption'); caption.textContent = 'A conceptual view · prepared for this example';
    figure.append(grid, caption);
  }

  function renderIdea(focus = false) {
    const card = cards[activeIdea];
    if (!card) return;
    $('ideaPosition').textContent = `IDEA ${String(activeIdea + 1).padStart(2, '0')} OF ${String(cards.length).padStart(2, '0')}`;
    $('ideaTitle').textContent = card.title;
    $('ideaBody').replaceChildren();
    card.content.split(/\n\s*\n/).filter(Boolean).forEach(text => { const paragraph = document.createElement('p'); paragraph.textContent = text.trim(); $('ideaBody').append(paragraph); });
    renderConcept();
    $('previousIdea').disabled = activeIdea === 0;
    $('nextIdea').textContent = activeIdea === cards.length - 1 ? (questions.length ? 'Check understanding →' : 'Back to first idea →') : 'Next idea →';
    $('listenStatus').textContent = '';
    renderTopics();
    if (focus) $('ideaTitle').focus({ preventScroll: true });
  }

  function goToIdea(index, focus = false) {
    if (!Number.isInteger(index) || index < 0 || index >= cards.length) return;
    stopSpeech(); activeIdea = index; visited.add(index); switchTab('ideas'); renderIdea(focus); persist();
  }

  function switchTab(name, focus = false) {
    if (name === 'ideas' && !cards.length) return;
    if (name === 'quiz' && !questions.length) return;
    stopSpeech(); tab = name;
    const ideas = name === 'ideas';
    $('ideasTab').setAttribute('aria-selected', String(ideas)); $('ideasTab').tabIndex = ideas ? 0 : -1;
    $('quizTab').setAttribute('aria-selected', String(!ideas)); $('quizTab').tabIndex = ideas ? -1 : 0;
    $('ideasPanel').hidden = !ideas; $('quizPanel').hidden = ideas;
    $('ideasNavigation').hidden = !ideas; $('quizContext').hidden = ideas;
    $('contextIdeas').hidden = !cards.length;
    if (!ideas) renderQuestion();
    if (focus) $(ideas ? 'ideasTab' : 'quizTab').focus();
    persist();
  }

  function renderQuestion(focus = false) {
    const summary = summarizeAnswers(questions, answers);
    $('completionView').hidden = !completedView; $('questionView').hidden = completedView;
    if (completedView) {
      $('quizPosition').textContent = 'KNOWLEDGE CHECK COMPLETE';
      $('completionTitle').textContent = summary.correct === summary.total ? 'The ideas are coming together.' : 'A little more understanding.';
      $('completionSummary').textContent = `You answered ${summary.correct} of ${summary.total} questions correctly. ${summary.correct === summary.total ? 'Return to the original paper to explore further.' : 'Review the answers, revisit the ideas, or give it another try.'}`;
      if (focus) $('completionTitle').focus({ preventScroll: true });
      return;
    }
    const question = questions[activeQuestion];
    if (!question) return;
    const checked = Object.hasOwn(answers, activeQuestion);
    selectedAnswer = checked ? answers[activeQuestion] : null;
    $('quizPosition').textContent = `QUESTION ${activeQuestion + 1} OF ${questions.length}`;
    $('questionText').textContent = question.question;
    $('questionHint').textContent = checked ? 'Your answer has been checked.' : 'Choose the best answer.';
    $('answerOptions').replaceChildren();
    question.options.forEach((text, index) => {
      const label = document.createElement('label'); label.className = 'quest-option';
      const input = document.createElement('input'); input.type = 'radio'; input.name = 'answer'; input.value = String(index); input.checked = selectedAnswer === index; input.disabled = checked;
      const answerText = document.createElement('span'); answerText.className = 'quest-option-text'; answerText.textContent = text;
      label.append(input, answerText);
      if (checked && index === question.answer) {
        label.classList.add('quest-answer-correct'); const status = document.createElement('span'); status.className = 'quest-option-status'; status.textContent = 'Correct answer'; label.append(status);
      } else if (checked && index === selectedAnswer) {
        label.classList.add('quest-answer-wrong'); const status = document.createElement('span'); status.className = 'quest-option-status'; status.textContent = 'Your answer'; label.append(status);
      }
      input.addEventListener('change', () => { selectedAnswer = index; $('checkAnswer').disabled = false; });
      $('answerOptions').append(label);
    });
    $('answerFeedback').hidden = !checked;
    $('answerFeedback').classList.toggle('quest-correct-feedback', checked && selectedAnswer === question.answer);
    $('answerFeedback').replaceChildren();
    if (checked) {
      const heading = document.createElement('strong'); heading.textContent = selectedAnswer === question.answer ? 'That’s right.' : 'A detail to revisit.';
      const explanation = document.createElement('span'); explanation.textContent = question.explanation || (selectedAnswer === question.answer ? 'You’ve identified the key idea. Continue when you’re ready.' : `The correct answer is “${question.options[question.answer]}”. Revisit the key ideas for more context.`);
      $('answerFeedback').append(heading, explanation);
    }
    $('checkAnswer').hidden = checked; $('checkAnswer').disabled = selectedAnswer === null;
    $('nextQuestion').hidden = !checked;
    $('nextQuestion').textContent = activeQuestion === questions.length - 1 ? (summary.answered === questions.length ? 'See results →' : 'Next unanswered →') : 'Next question →';
    $('previousQuestion').disabled = activeQuestion === 0;
    if (focus) $('questionText').focus({ preventScroll: true });
  }

  function acceptData(data, prepared) {
    cards = normalizeCards(data.flashcards); questions = normalizeQuestions(data.questions);
    if (!cards.length && !questions.length) throw new Error('empty');
    isExample = prepared;
    $('exampleBadge').hidden = !prepared;
    $('sourceNote').textContent = prepared ? 'Prepared example notes, based on this paper. Use the original PDF for the full argument.' : 'AI-generated study notes. Use the original PDF to check details.';
    if (prepared) {
      const paper = window.EasyArxivPapers.featured.find(item => item.id === '1706.03762');
      setPaperContext(data.title, paper?.authors, paper?.published, safePdf(data.pdf));
    }
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { /* Fresh progress when storage is malformed. */ }
    const restored = restoreProgress(saved, cards, questions);
    activeIdea = restored.activeIdea; activeQuestion = restored.activeQuestion; answers = restored.answers; visited = new Set(restored.visited); completedView = false;
    $('ideasTab').disabled = !cards.length; $('quizTab').disabled = !questions.length;
    $('backToIdeas').hidden = !cards.length;
    $('listenButton').disabled = !('speechSynthesis' in window && 'SpeechSynthesisUtterance' in window);
    $('listenButton').title = $('listenButton').disabled ? 'Speech is not available in this browser' : 'Read this idea aloud';
    $('questState').hidden = true; $('questWorkspace').hidden = false; $('questTabs').hidden = false;
    renderTopics(); renderIdea(); switchTab(restored.tab);
  }

  function loadExample() {
    controller?.abort(); clearTimeout(requestTimeout); requestId++;
    const data = window.EasyArxivPapers?.attentionQuest;
    if (!data) { showState('error', 'The example couldn’t be loaded.', 'Return to the papers and choose another one to explore.'); return; }
    storageKey = 'easyarxiv:web:quest:v1:demo:attention';
    const url = new URL(location.href); url.search = '?demo=attention'; history.replaceState(null, '', url);
    try { acceptData(data, true); } catch { showState('error', 'The example is unavailable.', 'Return to your papers and try again.'); }
  }

  async function loadPaper() {
    if (!pdf) {
      showState('empty', 'A paper is a good place to start.', params.has('pdf') ? 'This is not a supported arXiv PDF link. Choose a paper from the results, or explore the prepared example.' : 'Open AI Quest from a paper to explore its ideas, or try the prepared Attention Is All You Need example.');
      return;
    }
    storageKey = 'easyarxiv:web:quest:v1:' + pdf;
    controller?.abort(); clearTimeout(requestTimeout); stopSpeech();
    const id = ++requestId; controller = new AbortController();
    let timedOut = false;
    showState('loading', 'Opening the ideas behind your paper.', 'We’re preparing the key ideas and questions. This may take a minute. You can cancel whenever you like.');
    requestTimeout = setTimeout(() => { timedOut = true; controller.abort(); }, 90000);
    try {
      const response = await fetch('/api/getPaperData?pdf=' + encodeURIComponent(pdf), { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (id !== requestId) return;
      if (!response.ok) {
        const error = new Error('http'); error.status = response.status;
        try {
          const payload = await response.json();
          if (typeof payload.detail === 'string' && payload.detail.length <= 600) error.publicMessage = payload.detail;
        } catch { /* A useful generic message remains available for non-JSON responses. */ }
        throw error;
      }
      const data = await response.json();
      if (id !== requestId) return;
      acceptData(data, false);
    } catch (error) {
      if (id !== requestId || (error.name === 'AbortError' && !timedOut)) return;
      if (error.status === 401) {
        showState('signin', 'Sign in to generate AI Quest.', 'Continue with ORCID to prepare key ideas and questions for this paper. You can explore the prepared example without signing in.');
        return;
      }
      const unavailable = error.status === 503;
      const unconfigured = unavailable && /not configured|configuration/i.test(error.publicMessage || '');
      showState('error', unconfigured ? 'AI Quest isn’t configured here yet.' : unavailable ? 'AI Quest is temporarily unavailable.' : timedOut ? 'This paper is taking a little longer.' : error.message === 'empty' ? 'No usable study notes came back.' : 'We couldn’t prepare this Quest.', error.publicMessage || (unavailable ? 'AI analysis is unavailable on this server right now. You can still read the original paper or explore the clearly labeled prepared example.' : timedOut ? 'Preparation has stopped. Try again, return to your paper, or explore the prepared example.' : 'The paper or AI service may be unavailable. Try again, or explore the prepared example.'));
    } finally { if (id === requestId) clearTimeout(requestTimeout); }
  }

  $('ideasTab').addEventListener('click', () => switchTab('ideas'));
  $('quizTab').addEventListener('click', () => switchTab('quiz'));
  [$('ideasTab'), $('quizTab')].forEach(element => element.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const name = event.key === 'Home' ? 'ideas' : event.key === 'End' ? 'quiz' : tab === 'ideas' ? 'quiz' : 'ideas';
    switchTab(name, true);
  }));
  $('topicSelect').addEventListener('change', event => goToIdea(Number(event.target.value), false));
  $('previousIdea').addEventListener('click', () => goToIdea(activeIdea - 1, true));
  $('nextIdea').addEventListener('click', () => {
    if (activeIdea < cards.length - 1) goToIdea(activeIdea + 1, true);
    else if (questions.length) { switchTab('quiz'); $('questionText').focus({ preventScroll: true }); }
    else goToIdea(0, true);
  });
  $('listenButton').addEventListener('click', () => {
    const card=cards[activeIdea];if(!card)return;
    listenToText({title:card.title,text:`${card.title}. ${card.content}`},$('listenButton'));
    $('listenStatus').textContent='Choose your preferred voice and pace in the audio player.';
  });
  $('questionForm').addEventListener('submit', event => {
    event.preventDefault();
    if (selectedAnswer === null || Object.hasOwn(answers, activeQuestion)) return;
    answers[activeQuestion] = selectedAnswer; persist(); renderQuestion(); $('nextQuestion').focus({ preventScroll: true });
  });
  $('previousQuestion').addEventListener('click', () => { if (activeQuestion > 0) { activeQuestion--; renderQuestion(true); persist(); } });
  $('nextQuestion').addEventListener('click', () => {
    if (activeQuestion < questions.length - 1) activeQuestion++;
    else if (summarizeAnswers(questions, answers).answered === questions.length) completedView = true;
    else activeQuestion = questions.findIndex((_, index) => !Object.hasOwn(answers, index));
    renderQuestion(true); persist();
  });
  $('reviewAnswers').addEventListener('click', () => { completedView = false; const wrong = questions.findIndex((question, index) => answers[index] !== question.answer); activeQuestion = wrong < 0 ? 0 : wrong; renderQuestion(true); persist(); });
  $('restartQuiz').addEventListener('click', () => { answers = {}; activeQuestion = 0; completedView = false; persist(); renderQuestion(true); });
  [$('backToIdeas'), $('contextIdeas')].forEach(button => button.addEventListener('click', () => { switchTab('ideas'); $('ideaTitle').focus({ preventScroll: true }); }));
  $('retryButton').addEventListener('click', () => {
    if (requiresSignIn) window.location.assign('/auth/login');
    else loadPaper();
  });
  $('exampleButton').addEventListener('click', loadExample);
  $('cancelButton').addEventListener('click', () => { requestId++; controller?.abort(); clearTimeout(requestTimeout); showState('error', 'Quest preparation stopped.', 'You can try again when you’re ready, return to your papers, or explore the example.'); });
  window.addEventListener('pagehide', () => { requestId++; controller?.abort(); clearTimeout(requestTimeout); stopSpeech(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopSpeech(); });
  if (exampleRequested) loadExample(); else loadPaper();
}
