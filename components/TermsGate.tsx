// Blocks entry to the desktop — for guests and signed-in accounts alike —
// until the user has scrolled through and explicitly accepted the Terms
// of Service / Acceptable Use Policy. Requiring an actual scroll-to-bottom
// before the checkbox unlocks (not just a checkbox on its own) is a
// standard clickwrap practice: it's meant to establish that the user had
// a real opportunity to read the terms, not just an available link they
// could ignore.
//
// NOT a substitute for legal review. This is standard-form boilerplate
// covering the obvious cases (acceptable use, AI-output disclaimer,
// liability limitation, indemnification) — the governing-law and contact
// sections below are left as visible placeholders on purpose; fill them
// in (and have an actual lawyer review the rest) before leaning on this.

import React, { useState, useRef, useCallback } from 'react';
import { ShieldCheck } from 'lucide-react';
import { recordTermsAcceptance } from '../lib/terms';

interface TermsGateProps {
  onAccept: () => void;
}

const SCROLL_THRESHOLD_PX = 24;

export const TermsGate: React.FC<TermsGateProps> = ({ onAccept }) => {
  const [checked, setChecked] = useState(false);
  const [scrolledToBottom, setScrolledToBottom] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_THRESHOLD_PX) {
      setScrolledToBottom(true);
    }
  }, []);

  // A short document might never produce a scroll event at all (nothing to
  // scroll) — check once on mount so that case doesn't permanently block.
  const checkInitialFit = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    if (el && el.scrollHeight <= el.clientHeight + SCROLL_THRESHOLD_PX) {
      setScrolledToBottom(true);
    }
  }, []);

  const handleAccept = () => {
    recordTermsAcceptance();
    onAccept();
  };

  const canAccept = checked && scrolledToBottom;

  return (
    <div className="fixed inset-0 z-[20000] bg-[#050505] flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-[#0d0d14] border border-white/10 rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">
        <div className="p-5 border-b border-white/5 flex items-center gap-2 shrink-0">
          <ShieldCheck size={18} className="text-cyan-400" />
          <div>
            <h2 className="text-sm font-bold text-white uppercase tracking-widest">Terms of Service &amp; Acceptable Use</h2>
            <p className="text-[10px] text-gray-600 mt-0.5">A GI-Company Product — please read before continuing.</p>
          </div>
        </div>

        <div
          ref={checkInitialFit}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto p-5 text-[12px] leading-relaxed text-gray-400 space-y-4"
        >
          <p className="text-gray-500 text-[11px]">Last updated: 2026-08-14</p>

          <p>
            Welcome to Kernos OS, a product of GI-Company ("we," "us," "our," or the "Company"). These Terms of
            Service and Acceptable Use Policy (the "Terms") govern your access to and use of Kernos OS, including
            its agent, terminal, model-training, and network features (collectively, the "Service"). By accessing
            or using the Service — whether as a guest or as a registered account holder — you agree to be bound by
            these Terms. If you do not agree, do not use the Service.
          </p>

          <section>
            <h3 className="text-white font-semibold mb-1">1. Eligibility</h3>
            <p>
              You must be at least 13 years old to use the Service. If you are under 18, you may only use the
              Service with the involvement and consent of a parent or legal guardian who agrees to be bound by
              these Terms on your behalf.
            </p>
          </section>

          <section>
            <h3 className="text-white font-semibold mb-1">2. Description of the Service</h3>
            <p>
              Kernos OS is a browser-based workspace providing access to third-party large language models (via
              Groq), an in-browser trainable local language model ("BNLM"), a sandboxed command-line terminal,
              and — for signed-in accounts — real outbound network commands (including HTTP requests, DNS
              lookups, and headless-browser page rendering). The Service is provided on an experimental, "as-is"
              basis and may change, be limited, or be discontinued at any time without notice.
            </p>
          </section>

          <section>
            <h3 className="text-white font-semibold mb-1">3. Guest and Registered Accounts</h3>
            <p>
              You may use certain features of the Service anonymously as a guest, subject to usage limits
              (including a daily time quota tracked by IP address). Registered accounts unlock additional
              features, including persistent chat history, virtual filesystem storage, saved local models, and
              real network/terminal commands. You are responsible for maintaining the confidentiality of your
              account credentials and for all activity occurring under your account.
            </p>
          </section>

          <section>
            <h3 className="text-white font-semibold mb-1">4. Acceptable Use</h3>
            <p className="mb-2">You agree that you will NOT use the Service to:</p>
            <ul className="list-disc list-outside pl-4 space-y-1">
              <li>violate any applicable local, state, national, or international law or regulation;</li>
              <li>access, scan, probe, attack, or attempt to gain unauthorized access to any computer system, network, or account you do not own or have explicit authorization to access;</li>
              <li>transmit or generate malware, exploit code, spam, or other harmful or disruptive content;</li>
              <li>interfere with, degrade, or attempt to circumvent the Service's rate limits, sandboxing, or other technical safeguards;</li>
              <li>harass, threaten, defame, or violate the privacy or rights of any third party;</li>
              <li>upload, generate, or train models on content that infringes any intellectual property, publicity, or privacy right, or that constitutes unlawful content of any kind;</li>
              <li>use the Service's network or browser-rendering commands to conduct denial-of-service attacks, unauthorized scraping in violation of a target site's terms, port scanning, or reconnaissance against systems you do not own or have permission to test; or</li>
              <li>resell, sublicense, or provide third parties with access to the Service in a manner not expressly permitted by us.</li>
            </ul>
            <p className="mt-2">
              You are solely responsible for your use of the Service, including any commands you run, any content
              you submit to or generate through the Service, and any consequences — legal or otherwise — of your
              actions. Where the Service allows outbound network requests or headless-browser page loads, you
              represent that you have all necessary rights and authorization to access the destination systems and
              content, and that your use complies with the terms of service of any third party you interact with
              through the Service.
            </p>
          </section>

          <section>
            <h3 className="text-white font-semibold mb-1">5. AI-Generated Content</h3>
            <p>
              The Service uses third-party and locally-trained AI models to generate text, code, and other
              content. AI-generated output may be inaccurate, incomplete, biased, or offensive, and does not
              constitute professional advice of any kind (including legal, financial, medical, or security
              advice). You are responsible for independently verifying any output before relying on it.
            </p>
          </section>

          <section>
            <h3 className="text-white font-semibold mb-1">6. Monitoring and Enforcement</h3>
            <p>
              We reserve the right, but assume no obligation, to monitor use of the Service for compliance with
              these Terms, and to suspend, rate-limit, or terminate access — for any account or guest session,
              without notice — for conduct we believe violates these Terms or is otherwise harmful to the Service
              or third parties.
            </p>
          </section>

          <section>
            <h3 className="text-white font-semibold mb-1">7. Third-Party Services</h3>
            <p>
              The Service relies on third-party infrastructure and APIs, including Groq, Supabase, and Vercel. We
              do not control and are not responsible for the availability, security, or behavior of these
              third-party services.
            </p>
          </section>

          <section>
            <h3 className="text-white font-semibold mb-1">8. Intellectual Property</h3>
            <p>
              The Service, including its software, design, and branding, is owned by GI-Company or its licensors.
              Content you submit remains yours; you grant us a limited license to process it solely as necessary
              to operate the Service.
            </p>
          </section>

          <section>
            <h3 className="text-white font-semibold mb-1">9. Disclaimer of Warranties</h3>
            <p className="uppercase text-[11px] tracking-wide">
              The Service is provided "as is" and "as available," without warranties of any kind, express or
              implied, including without limitation warranties of merchantability, fitness for a particular
              purpose, non-infringement, or that the Service will be uninterrupted, secure, or error-free.
            </p>
          </section>

          <section>
            <h3 className="text-white font-semibold mb-1">10. Limitation of Liability</h3>
            <p className="uppercase text-[11px] tracking-wide">
              To the maximum extent permitted by law, GI-Company and its operators, contributors, and affiliates
              shall not be liable for any indirect, incidental, special, consequential, or punitive damages, or
              any loss of data, profits, or goodwill, arising out of or related to your use of the Service —
              including any actions taken by you or through your account or guest session using the Service's
              terminal, network, or browser-rendering features — even if advised of the possibility of such
              damages.
            </p>
          </section>

          <section>
            <h3 className="text-white font-semibold mb-1">11. Indemnification</h3>
            <p>
              You agree to indemnify and hold harmless GI-Company and its operators, contributors, and affiliates
              from any claims, damages, liabilities, and expenses (including reasonable legal fees) arising out of
              or related to your use of the Service, your violation of these Terms, or your violation of any
              rights of a third party.
            </p>
          </section>

          <section>
            <h3 className="text-white font-semibold mb-1">12. Changes to These Terms</h3>
            <p>
              We may update these Terms from time to time. Continued use of the Service after changes take effect
              constitutes acceptance of the revised Terms. Material changes will update the "Last updated" date
              above and may require re-acceptance.
            </p>
          </section>

          <section>
            <h3 className="text-white font-semibold mb-1">13. Governing Law and Venue</h3>
            <p>
              These Terms shall be governed by and construed in accordance with the laws of the State of Georgia,
              United States, without regard to its conflict of law provisions. You agree to submit to the
              exclusive jurisdiction of the state and federal courts located in the State of Georgia for the
              resolution of any disputes arising out of or relating to these Terms or the Service.
            </p>
          </section>

          <section>
            <h3 className="text-white font-semibold mb-1">14. Contact</h3>
            <p>
              Questions about these Terms can be sent to: <span className="text-gray-300">g.intel.co@outlook.com</span>
            </p>
          </section>

          <p className="text-white font-semibold pt-2">
            By checking the box below and clicking "I Agree — Continue," you acknowledge that you have read,
            understood, and agree to be bound by these Terms of Service and Acceptable Use Policy.
          </p>
        </div>

        <div className="p-5 border-t border-white/5 flex flex-col gap-3 shrink-0">
          {!scrolledToBottom && (
            <div className="text-[10px] text-amber-400/80 text-center">Scroll to the bottom to continue.</div>
          )}
          <label className={`flex items-start gap-2 text-xs text-gray-400 ${scrolledToBottom ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
            <input
              type="checkbox"
              checked={checked}
              onChange={e => setChecked(e.target.checked)}
              disabled={!scrolledToBottom}
              className="mt-0.5"
            />
            <span>
              I have read and agree to the Terms of Service and Acceptable Use Policy, including the limitation of
              liability and indemnification sections.
            </span>
          </label>
          <button
            onClick={handleAccept}
            disabled={!canAccept}
            className="w-full py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 text-white text-sm font-bold hover:from-cyan-400 hover:to-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            I Agree — Continue
          </button>
        </div>
      </div>
    </div>
  );
};
