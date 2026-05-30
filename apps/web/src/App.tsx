import { Router, Route } from 'preact-iso';
import { useSession } from './lib/auth';
import { Spinner } from './components/ui/controls';
import { Layout } from './components/Layout';
import { Login } from './routes/Login';
import { Overview } from './routes/Overview';
import { Issues } from './routes/Issues';
import { Agents } from './routes/Agents';
import { Probes } from './routes/Probes';
import { Incidents } from './routes/Incidents';

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
      <Router>
        <Route path="/" component={Overview} />
        <Route path="/issues" component={Issues} />
        <Route path="/agents" component={Agents} />
        <Route path="/probes" component={Probes} />
        <Route path="/incidents" component={Incidents} />
        <Route default component={Overview} />
      </Router>
    </Layout>
  );
}
