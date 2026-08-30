import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Toaster } from 'sonner';
import { Layout } from './components/Layout';
import { ProjectListPage } from './pages/ProjectListPage';
import { ProjectDashboardPage } from './pages/ProjectDashboardPage';
import { TasksPage } from './pages/TasksPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { ProjectSettingsPage, SettingsPage } from './pages/SettingsPage';
import { AgentsPage } from './pages/AgentsPage';
import { AutoPage } from './pages/AutoPage';
import { FilesPage } from './pages/FilesPage';
import { RequirementsPage } from './pages/RequirementsPage';
import { DesignsPage } from './pages/DesignsPage';
import './index.css';
import 'react-diff-view/style/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Toaster richColors closeButton position="top-center" duration={5000} />
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<ProjectListPage />} />
          <Route path="projects/:projectId" element={<ProjectDashboardPage />} />
          <Route path="projects/:projectId/tasks" element={<TasksPage />} />
          <Route path="projects/:projectId/tasks/:taskId" element={<TaskDetailPage />} />
          <Route path="projects/:projectId/files" element={<FilesPage />} />
          <Route path="projects/:projectId/requirements" element={<RequirementsPage />} />
          <Route path="projects/:projectId/designs" element={<DesignsPage />} />
          <Route path="projects/:projectId/agents" element={<AgentsPage />} />
          <Route path="projects/:projectId/auto" element={<AutoPage />} />
          <Route path="projects/:projectId/settings" element={<ProjectSettingsPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
