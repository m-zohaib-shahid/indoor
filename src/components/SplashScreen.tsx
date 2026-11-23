import React, { useEffect } from 'react';
import { motion, useReducedMotion } from 'motion/react';

interface SplashScreenProps {
  onComplete: () => void;
  durationMs?: number;
}

const WORD_ONE = ['I', 'n', 'd', 'o', 'o', 'r'];
const WORD_TWO = ['N', 'a', 'v', 'i', 'g', 'a', 't', 'i', 'o', 'n'];

export const SplashScreen: React.FC<SplashScreenProps> = ({
  onComplete,
  durationMs = 2400,
}) => {
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      onComplete();
    }, prefersReducedMotion ? 1400 : durationMs);

    return () => window.clearTimeout(timer);
  }, [onComplete, durationMs, prefersReducedMotion]);

  return (
    <div
      className="relative min-h-[100dvh] w-full bg-[#0B0F17] text-slate-100 flex flex-col items-center justify-center px-6 overflow-hidden select-none"
      aria-label="Indoor Navigation intro"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.12]"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, rgba(148, 163, 184, 0.35) 1px, transparent 0)',
          backgroundSize: '28px 28px',
        }}
      />

      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 -left-40 w-[30rem] h-[30rem] rounded-full bg-sky-500/8 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-40 -right-40 w-[30rem] h-[30rem] rounded-full bg-blue-600/8 blur-3xl"
      />

      <div className="relative z-10 flex flex-col items-center text-center">
        <motion.div
          initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.82 }}
          animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="relative w-24 h-24 flex items-center justify-center mb-6"
        >
          {!prefersReducedMotion && (
            <motion.div
              aria-hidden="true"
              className="absolute inset-0 rounded-2xl border border-sky-400/40"
              initial={{ opacity: 0.65, scale: 0.92 }}
              animate={{ opacity: [0.55, 0], scale: [0.95, 1.42] }}
              transition={{
                duration: 1.8,
                delay: 0.35,
                repeat: Infinity,
                ease: 'easeOut',
              }}
            />
          )}

          <div className="w-20 h-20 rounded-2xl bg-gradient-to-tr from-sky-400/80 to-blue-500/80 p-[1.5px] shadow-[0_18px_45px_rgba(11,15,23,0.85)]">
            <div className="w-full h-full rounded-[14.5px] bg-[#111622] flex items-center justify-center">
              <svg
                viewBox="0 0 64 64"
                className="w-12 h-12"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <defs>
                  <linearGradient
                    id="nav-emblem-grad"
                    x1="12"
                    y1="10"
                    x2="52"
                    y2="54"
                    gradientUnits="userSpaceOnUse"
                  >
                    <stop offset="0%" stopColor="#38BDF8" />
                    <stop offset="100%" stopColor="#3B82F6" />
                  </linearGradient>
                </defs>

                <motion.circle
                  cx="32"
                  cy="32"
                  r="21"
                  stroke="url(#nav-emblem-grad)"
                  strokeWidth="2.2"
                  strokeOpacity="0.65"
                  initial={prefersReducedMotion ? { opacity: 1 } : { pathLength: 0, opacity: 0 }}
                  animate={prefersReducedMotion ? { opacity: 1 } : { pathLength: 1, opacity: 1 }}
                  transition={{ duration: 0.7, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
                />

                <motion.circle
                  cx="32"
                  cy="32"
                  r="13.5"
                  stroke="#38BDF8"
                  strokeWidth="1.5"
                  strokeOpacity="0.35"
                  strokeDasharray="3 3"
                  initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, scale: 0.78 }}
                  animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
                  transition={{ duration: 0.45, delay: 0.25, ease: [0.16, 1, 0.3, 1] }}
                />

                <motion.g
                  style={{ transformOrigin: '32px 32px' }}
                  initial={
                    prefersReducedMotion
                      ? { opacity: 0 }
                      : { opacity: 0, rotate: -30, scale: 0.75 }
                  }
                  animate={
                    prefersReducedMotion
                      ? { opacity: 1 }
                      : { opacity: 1, rotate: 0, scale: 1 }
                  }
                  transition={{ duration: 0.6, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
                >
                  <polygon points="32,14 40,32 32,27.5 24,32" fill="#38BDF8" />
                  <polygon
                    points="32,50 40,32 32,36.5 24,32"
                    fill="#3B82F6"
                    fillOpacity="0.85"
                  />
                  <circle cx="32" cy="32" r="3" fill="#FFFFFF" />
                </motion.g>
              </svg>
            </div>
          </div>
        </motion.div>

        <h1
          className="text-3xl sm:text-5xl font-bold tracking-tight text-white flex flex-wrap items-center justify-center gap-x-3 min-h-[3.5rem] [text-wrap:balance]"
          aria-label="Indoor Navigation"
        >
          <span className="inline-flex">
            {WORD_ONE.map((char, index) => (
              <motion.span
                key={`w1-${char}-${index}`}
                initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 14 }}
                animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
                transition={{
                  duration: 0.38,
                  delay: prefersReducedMotion ? 0.1 : 0.38 + index * 0.035,
                  ease: [0.16, 1, 0.3, 1],
                }}
                className="inline-block text-white"
              >
                {char}
              </motion.span>
            ))}
          </span>

          <span className="inline-flex">
            {WORD_TWO.map((char, index) => (
              <motion.span
                key={`w2-${char}-${index}`}
                initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 14 }}
                animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
                transition={{
                  duration: 0.38,
                  delay: prefersReducedMotion ? 0.1 : 0.6 + index * 0.035,
                  ease: [0.16, 1, 0.3, 1],
                }}
                className="inline-block text-sky-400"
              >
                {char}
              </motion.span>
            ))}
          </span>
        </h1>

        <motion.p
          initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
          animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
          transition={{
            duration: 0.45,
            delay: prefersReducedMotion ? 0.24 : 1.08,
            ease: [0.16, 1, 0.3, 1],
          }}
          className="mt-3 text-sm sm:text-base font-medium text-slate-400 tracking-wide"
        >
          Enterprise indoor positioning &amp; live wayfinding.
        </motion.p>
      </div>
    </div>
  );
};
