import { Router, Route } from 'preact-iso';
import { useSession } from './lib/auth';
import { Spinner } from './components/ui/controls';
import { Layout } from './components/Layout';
import { Login } from './routes/Login';
import { Overview } from './routes/Overview';
import { ProjectDetail } from './routes/ProjectDetail';
import { Issues } from './routes/Issues';
import { Agents } from './routes/Agents';
import { Probes } from './routes/Probes';
import { Incidents } from './routes/Incidents';
import { Remediation } from './routes/Remediation';

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
        <Route path="/projects/:id" component={ProjectDetail} />
        <Route path="/issues" component={Issues} />
        <Route path="/agents" component={Agents} />
        <Route path="/probes" component={Probes} />
        <Route path="/incidents" component={Incidents} />
        <Route path="/remediation" component={Remediation} />
        <Route default component={Overview} />
      </Router>
    </Layout>
  );
}
