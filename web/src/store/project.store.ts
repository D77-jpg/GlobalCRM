import { create } from 'zustand';
import { apiDelete, apiGet, apiPost, apiPut, setRequestProjectScope, toErrorMessage } from '@/lib/api';
import { STORAGE_KEYS } from '@/constants';
import { readStorage, removeStorage, writeStorage } from '@/lib/utils';
import type { CreateProjectInput, Project, UpdateProjectInput } from '@/types';

let initialisation = 0;

function saveProjectChoice(id?: string): void {
  try {
    if (id) sessionStorage.setItem(STORAGE_KEYS.activeProject, id);
    else sessionStorage.removeItem(STORAGE_KEYS.activeProject);
  } catch { /* Browser storage can be disabled. */ }
  if (id) writeStorage(STORAGE_KEYS.activeProject, id);
  else removeStorage(STORAGE_KEYS.activeProject);
}

function savedProjectChoice(): string | null {
  try {
    const selected = sessionStorage.getItem(STORAGE_KEYS.activeProject);
    if (selected) return selected;
  } catch { /* Use the browser preference if available. */ }
  return readStorage<string | null>(STORAGE_KEYS.activeProject, null);
}

interface ProjectState {
  items: Project[];
  activeProject: Project | null;
  loading: boolean;
  initialized: boolean;
  error: string | null;
  initialize: (force?: boolean) => Promise<void>;
  switchProject: (id: string) => void;
  createProject: (input: CreateProjectInput) => Promise<Project>;
  updateProject: (id: string, input: UpdateProjectInput) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  reset: () => void;
}

export const useProjectStore = create<ProjectState>()((set, get) => ({
  items: [], activeProject: null, loading: false, initialized: false, error: null,
  async initialize(force = false) {
    if (get().loading || (get().initialized && !force)) return;
    const generation = ++initialisation;
    set({ loading: true, error: null, ...(force ? { initialized: false, activeProject: null } : {}) });
    try {
      const items = await apiGet<Project[]>('/projects');
      if (generation !== initialisation) return;
      const saved = savedProjectChoice();
      const activeProject = items.find((item) => item.id === saved && item.status === 'active')
        ?? items.find((item) => item.isDefault && item.status === 'active')
        ?? items.find((item) => item.status === 'active')
        ?? null;
      saveProjectChoice(activeProject?.id);
      setRequestProjectScope(activeProject?.id);
      set({ items, activeProject, loading: false, initialized: true, error: activeProject ? null : '当前账号没有可访问的项目' });
    } catch (error) {
      if (generation !== initialisation) return;
      set({ loading: false, initialized: true, error: toErrorMessage(error, '项目列表加载失败') });
    }
  },
  switchProject(id) {
    const project = get().items.find((item) => item.id === id && item.status === 'active');
    if (!project || project.id === get().activeProject?.id) return;
    // The old page can still have pending edits until navigation takes effect.
    saveProjectChoice(project.id);
    window.location.assign('/');
  },
  async createProject(input) {
    const project = await apiPost<Project>('/projects', input);
    set((state) => ({ items: [...state.items, project].sort((a, b) => a.name.localeCompare(b.name)) }));
    return project;
  },
  async updateProject(id, input) {
    const project = await apiPut<Project>(`/projects/${id}`, input);
    set((state) => ({ items: state.items.map((item) => item.id === id ? { ...item, ...project } : item),
      activeProject: state.activeProject?.id === id ? { ...state.activeProject, ...project } : state.activeProject }));
    return project;
  },
  async deleteProject(id) {
    await apiDelete<{ name: string }>(`/projects/${id}`);
    const wasActive = get().activeProject?.id === id;
    set((state) => ({ items: state.items.filter((item) => item.id !== id) }));
    if (wasActive) {
      saveProjectChoice();
      setRequestProjectScope();
      await get().initialize(true);
    }
  },
  reset() {
    initialisation++;
    setRequestProjectScope();
    set({ items: [], activeProject: null, loading: false, initialized: false, error: null });
  },
}));
