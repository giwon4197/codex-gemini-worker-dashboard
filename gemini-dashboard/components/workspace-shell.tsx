'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { 
  Bot, 
  Terminal, 
  Cpu, 
  Menu, 
  X, 
  FolderGit2,
  Zap,
  Activity
} from 'lucide-react';
import type { ProjectSummary } from '../lib/workspace-contract';

interface WorkspaceShellProps {
  activeTab: 'workspace' | 'projects';
  children: React.ReactNode;
  projects?: ProjectSummary[];
  activeWorkersCount?: number;
  currentProjectName?: string;
}

export function WorkspaceShell({
  activeTab,
  children,
  activeWorkersCount = 0,
  currentProjectName = 'codex-gemini-worker-dashboard',
}: WorkspaceShellProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground font-sans">
      {/* Mobile Backdrop */}
      {mobileMenuOpen && (
        <div
          role="presentation"
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-xs md:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Accessible Navigation Sidebar */}
      <aside
        aria-label="주요 프로젝트 및 기능 탐색 사이드바"
        className={`fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-border bg-[#0b0f17] transition-transform duration-200 md:static md:translate-x-0 ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Workspace Brand & Current Project */}
        <div className="flex h-16 items-center justify-between border-b border-border/80 px-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-400 ring-1 ring-cyan-400/30">
              <Bot className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-semibold tracking-tight text-white">
                Codex 워크스페이스
              </span>
              <span className="text-[11px] text-slate-400 font-mono">
                Gemini 워커 라우터
              </span>
            </div>
          </div>
          <button
            type="button"
            aria-label="사이드바 닫기"
            className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-white md:hidden"
            onClick={() => setMobileMenuOpen(false)}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {/* Current Project Selector Display */}
        <div className="p-3 border-b border-border/60">
          <label htmlFor="project-selector-label" className="sr-only">현재 프로젝트</label>
          <div 
            id="project-selector-label"
            className="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-card/60 p-3 shadow-xs"
          >
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span className="flex items-center gap-1.5 font-medium">
                <FolderGit2 className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
                현재 프로젝트
              </span>
              <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                정상
              </span>
            </div>
            <div className="text-xs font-semibold text-slate-200 truncate font-mono">
              {currentProjectName}
            </div>
          </div>
        </div>

        {/* Main Navigation */}
        <nav role="navigation" aria-label="메인 내비게이션" className="flex-1 space-y-1.5 p-3">
          <Link
            href="/"
            aria-current={activeTab === 'workspace' ? 'page' : undefined}
            onClick={() => setMobileMenuOpen(false)}
            className={`group flex items-center justify-between rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-400 ${
              activeTab === 'workspace'
                ? 'bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/30 font-semibold'
                : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
            }`}
          >
            <div className="flex items-center gap-3">
              <Terminal className={`h-4 w-4 ${activeTab === 'workspace' ? 'text-cyan-400' : 'text-slate-400 group-hover:text-slate-200'}`} aria-hidden="true" />
              <div className="flex flex-col text-left">
                <span>대화형 작업 공간</span>
                <span className="text-[11px] font-normal text-slate-400">
                  자연어 작업 지시 및 타임라인
                </span>
              </div>
            </div>
            {activeTab === 'workspace' && (
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" aria-hidden="true" />
            )}
          </Link>

          <Link
            href="/projects"
            aria-current={activeTab === 'projects' ? 'page' : undefined}
            onClick={() => setMobileMenuOpen(false)}
            className={`group flex items-center justify-between rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-400 ${
              activeTab === 'projects'
                ? 'bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/30 font-semibold'
                : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
            }`}
          >
            <div className="flex items-center gap-3">
              <Activity className={`h-4 w-4 ${activeTab === 'projects' ? 'text-cyan-400' : 'text-slate-400 group-hover:text-slate-200'}`} aria-hidden="true" />
              <div className="flex flex-col text-left">
                <span>프로젝트 관제</span>
                <span className="text-[11px] font-normal text-slate-400">
                  활성 워커 CLI 및 모니터링
                </span>
              </div>
            </div>
            {activeWorkersCount > 0 ? (
              <span className="inline-flex items-center rounded-full bg-cyan-500/20 px-2 py-0.5 text-[11px] font-semibold text-cyan-300 ring-1 ring-cyan-400/40">
                {activeWorkersCount} 실행
              </span>
            ) : (
              activeTab === 'projects' && (
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" aria-hidden="true" />
              )
            )}
          </Link>
        </nav>

        {/* Sidebar Footer System Status */}
        <div className="border-t border-border/80 p-3.5 bg-black/20">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span className="flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
              라우터 연동
            </span>
            <span className="text-slate-300 font-mono">로컬 활성</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] text-slate-400">
            <span className="flex items-center gap-1.5">
              <Cpu className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
              오케스트레이터
            </span>
            <span className="text-emerald-400 font-mono">준비됨</span>
          </div>
        </div>
      </aside>

      {/* Main App Content Area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile Header Bar */}
        <header
          role="banner"
          className="flex h-14 items-center justify-between border-b border-border bg-card/60 px-4 md:hidden"
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="내비게이션 메뉴 열기"
              className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-slate-800/80 text-slate-200"
              onClick={() => setMobileMenuOpen(true)}
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
            </button>
            <span className="text-sm font-semibold text-white">
              {activeTab === 'workspace' ? '대화형 작업 공간' : '프로젝트 관제'}
            </span>
          </div>

          {activeWorkersCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-cyan-500/20 px-2 py-0.5 text-xs text-cyan-300 ring-1 ring-cyan-400/40">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" />
              {activeWorkersCount} 활성 워커
            </span>
          )}
        </header>

        {/* Page Content */}
        <main role="main" className="flex-1 overflow-y-auto bg-background">
          {children}
        </main>
      </div>
    </div>
  );
}