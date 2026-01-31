import 'bootstrap/dist/css/bootstrap.min.css';
import './index.css';
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from './App.jsx'

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (error?.status === 401) {
        localStorage.removeItem('meetai_token');
        localStorage.removeItem('meetai_user');
        window.location.assign('/login');
      }
    },
  }),
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
  </StrictMode>,
)
