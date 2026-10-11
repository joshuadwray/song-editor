import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/choreo/ui/App';
import '../src/choreo/ui/styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
