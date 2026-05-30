import { render } from 'preact';
import { LocationProvider } from 'preact-iso';
import { App } from './App';
import { ToastProvider } from './components/ui/toast';
import './styles.css';

render(
  <LocationProvider>
    <ToastProvider>
      <App />
    </ToastProvider>
  </LocationProvider>,
  document.getElementById('app')!,
);
