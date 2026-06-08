import { Router, Route, lazy, ErrorBoundary } from 'preact-iso';
import { useSession } from './lib/auth';
import { Spinner } from './components/ui/controls';
import { Layout } from './components/Layout';
import { Login } from './routes/Login';

// Route-level code-splitting (F011.4): each route is its own chunk, loaded on
// navigation, so the initial bundle is just the shell + auth. Keeps the heavy
// deps (Recharts in Agents/Probes) out of first paint. preact-iso's Router
// suspends seamlessly while a route chunk loads; ErrorBoundary catches it.
const Overview = lazy(() => import('./routes/Overview').then((m) => m.Overview));
const ProjectDetail = lazy(() => import('./routes/ProjectDetail').then((m) => m.ProjectDetail));
const Issues = lazy(() => import('./routes/Issues').then((m) => m.Issues));
const Agents = lazy(() => import('./routes/Agents').then((m) => m.Agents));
const Probes = lazy(() => import('./routes/Probes').then((m) => m.Probes));
const Deploys = lazy(() => import('./routes/Deploys').then((m) => m.Deploys));
const Incidents = lazy(() => import('./routes/Incidents').then((m) => m.Incidents));
const Remediation = lazy(() => import('./routes/Remediation').then((m) => m.Remediation));

export function App() {
  const { loading, user } = useSession();

  if (loading) {
    return (
      <div class="grid h-full place-items-center">
        <Spinner size={28} />
      </div>
    );
  }

  if (!user) return <Login />;

  return (
    <Layout user={user}>
      <ErrorBoundary>
        <Router>
          <Route path="/" component={Overview} />
          <Route path="/projects/:id" component={ProjectDetail} />
          <Route path="/issues" component={Issues} />
          <Route path="/agents" component={Agents} />
          <Route path="/probes" component={Probes} />
          <Route path="/deploys" component={Deploys} />
          <Route path="/incidents" component={Incidents} />
          <Route path="/remediation" component={Remediation} />
          <Route default component={Overview} />
        </Router>
      </ErrorBoundary>
    </Layout>
  );
}
