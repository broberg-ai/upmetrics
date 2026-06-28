import { render } from 'preact';
import { LocationProvider } from 'preact-iso';
import { App } from './App';
import { ToastProvider } from './components/ui/toast';
import { loadUsdToDkk } from './lib/format';
import './styles.css';

// F023 — pull the live USD→DKK rate once on boot so dkk() formats with the real
// rate (fire-and-forget; dkk() falls back to its default until this resolves).
void loadUsdToDkk();

render(
  <LocationProvider>
    <ToastProvider>
      <App />
    </ToastProvider>
  </LocationProvider>,
  document.getElementById('app')!,
);
