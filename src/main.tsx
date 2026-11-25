import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { loadAutosave } from './io/autosave';
import { demoProject } from './model/demoSong';
import { App } from './ui/App';
import { initStore } from './ui/store';

async function main() {
  // Resume the last session; first visit starts with the demo song.
  const project = (await loadAutosave()) ?? demoProject();
  initStore(project);
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void main();
