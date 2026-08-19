import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProjectListPage } from './pages/ProjectListPage';
import { ProjectDashboardPage } from './pages/ProjectDashboardPage';
import { TasksPage } from './pages/TasksPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { ProjectSettingsPage, SettingsPage } from './pages/SettingsPage';
import './index.css';
import 'react-diff-view/style/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<ProjectListPage />} />
          <Route path="projects/:projectId" element={<ProjectDashboardPage />} />
          <Route path="projects/:projectId/tasks" element={<TasksPage />} />
          <Route path="projects/:projectId/tasks/:taskId" element={<TaskDetailPage />} />
          <Route path="projects/:projectId/settings" element={<ProjectSettingsPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
