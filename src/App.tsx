import React, { useState, useCallback, useEffect, useRef } from 'react';
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { SplashScreen } from './components/SplashScreen';
import { AuthScreen } from './components/AuthScreen';
import { CleanNavigationDashboard } from './components/CleanNavigationDashboard';
import { authService, AuthUser } from './services/authService';
import { initialOAuthCallbackError } from './lib/insforge';

type AppScreen = 'splash' | 'auth' | 'dashboard';

interface ErrorBoundaryState {
  hasError: boolean;
}

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[100dvh] w-full bg-[#0B0F17] text-slate-100 flex items-center justify-center p-6 overflow-x-hidden">
          <div className="max-w-md w-full bg-[#111622] border border-slate-800 rounded-2xl p-6 text-center space-y-4 shadow-2xl">
            <h1 className="text-lg font-bold text-white">IndoorNav</h1>
            <p className="text-sm text-slate-400">
              The interface encountered an unexpected issue. Reload to continue.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="w-full min-h-[44px] py-2.5 px-4 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-bold transition-colors"
            >
              Reload App
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const prefersReducedMotion = useReducedMotion();
  const [screen, setScreen] = useState<AppScreen>('splash');
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [authBannerError, setAuthBannerError] = useState<string | null>(
    initialOAuthCallbackError
  );

  const sessionCheckRef = useRef<Promise<AuthUser | null> | null>(null);

  useEffect(() => {
    // Resolve real InsForge session (and any OAuth PKCE callback) in parallel with SplashScreen
    sessionCheckRef.current = authService.getCurrentUser();
  }, []);

  const handleSplashComplete = useCallback(async () => {
    const checkPromise = sessionCheckRef.current ?? authService.getCurrentUser();
    const existingUser = await checkPromise;
    if (existingUser) {
      setCurrentUser(existingUser);
      setAuthBannerError(null);
      setScreen('dashboard');
    } else {
      setScreen('auth');
    }
  }, []);

  const handleAuthSuccess = useCallback((user: AuthUser) => {
    setCurrentUser(user);
    setAuthBannerError(null);
    setScreen('dashboard');
  }, []);

  const handleSignOut = useCallback(async () => {
    await authService.signOut();
    setCurrentUser(null);
    setAuthBannerError(null);
    setScreen('auth');
  }, []);

  const pageVariants = prefersReducedMotion
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
      }
    : {
        initial: { opacity: 0, y: 10 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -10 },
      };

  return (
    <AppErrorBoundary>
      <MotionConfig reducedMotion="user">
        <div className="relative min-h-[100dvh] w-full bg-[#0B0F17] select-none overflow-x-hidden">
          <AnimatePresence mode="wait">
            {screen === 'splash' && (
              <motion.div
                key="splash"
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              >
                <SplashScreen onComplete={handleSplashComplete} />
              </motion.div>
            )}

            {screen === 'auth' && (
              <motion.div
                key="auth"
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              >
                <AuthScreen
                  onAuthSuccess={handleAuthSuccess}
                  initialError={authBannerError}
                />
              </motion.div>
            )}

            {screen === 'dashboard' && currentUser && (
              <motion.div
                key="dashboard"
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              >
                <CleanNavigationDashboard
                  currentUser={currentUser}
                  onSignOut={handleSignOut}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </MotionConfig>
    </AppErrorBoundary>
  );
}
