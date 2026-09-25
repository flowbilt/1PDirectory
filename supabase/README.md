# Supabase setup

Do these once. The current site keeps running as it is until the new build is deployed, so nothing here affects the Landmark Center screen.

## 1. Create the project

1. In Supabase, create a **new project** just for the directory. Keep it separate from FlowBilt.
2. Pick the US East region and save the database password in your password manager.

## 2. Build the database

1. Open **SQL Editor → New query**.
2. Paste all of `01-schema.sql` and click **Run**. It should finish with "Success. No rows returned."
3. New query again: paste all of `02-seed.sql` and click **Run**. This loads the 16 directories and 83 tenants from Yodeck, Wix and the Landmark Center.
4. For remote management of the Pis: new query, paste all of `03-agent.sql`, and click **Run**. This adds the device tables and pre-registers the 15 Yodeck Pis by serial number.
5. For the daily health history: new query, paste all of `04-health.sql`, and click **Run**.
6. For cheaper check-ins: new query, paste all of `05-tuning.sql`, and click **Run**. Then new query, paste all of `check-tuning.sql`, and click **Run**. That one always ends with a red message on purpose (it undoes its own test data); it should read **ALL 10 CHECKS PASSED**.
7. For the trust fixes (DP-02): **only after the DP-02 code is live on Netlify**, new query, paste all of `06-trust.sql`, and click **Run**. Then new query, paste all of `check-trust.sql`, and click **Run**. Like `check-tuning.sql` it ends with a red message on purpose; it should read **ALL 9 CHECKS PASSED**. (Run in the other order, the old console would stop loading screens until the new code arrived: `06` stops signed-in users reading every screen column, and the old console asks for all of them.)
8. For uptime counting (DP-02 round 2): **before uploading the round 2 code**, new query, paste all of `07-uptime.sql`, and click **Run**. Then new query, paste all of `check-uptime.sql`, and click **Run**; it should read **ALL 10 CHECKS PASSED** (red on purpose). (The new Health tab reads a column this file adds; the old code doesn't mind it, so this order has no gap.)

If any of them shows an error (other than the expected red messages from the `check-…sql` files), copy the message (it includes a line number) and send it to Claude.

## 3. Lock down sign-ups

Under **Authentication → Sign In / Providers**:

- Turn **off** "Allow new users to sign up". Only people you invite should get in.
- Leave **Email** enabled.

Under **Authentication → URL Configuration**:

- **Site URL:** `https://1pdirectory.netlify.app`
- **Redirect URLs:** add `https://1pdirectory.netlify.app/**`

## 4. Email for invitations and password resets

Supabase's built-in email only sends a few messages an hour and is meant for testing. Under **Authentication → Emails → SMTP Settings**, turn on custom SMTP and enter your email provider's details (for example Resend). Use a sender like `directory@1pointusa.com`.

## 5. Make yourself the first admin

1. **Authentication → Users → Add user → Create new user.** Enter your email and a password, and tick **Auto Confirm User**.
2. In the SQL Editor, run this, with your email in place of the example:

   ```sql
   insert into public.profiles (user_id, email, full_name, role)
     select id, email, 'Scot', 'platform_admin' from auth.users where email = 'you@1pointusa.com';
   ```

Everyone else gets invited from inside the new console once it's built.

## 6. Keys for Netlify

Under **Project Settings → API Keys**, you'll find three values. Add them in Netlify under **Project configuration → Environment variables**, but **don't redeploy yet**. The current code doesn't use them.

| Netlify variable | Supabase value | Secret? |
|---|---|---|
| `SUPABASE_URL` | Project URL | No |
| `SUPABASE_ANON_KEY` | Publishable key (or the legacy "anon" key) | No |
| `SUPABASE_SERVICE_KEY` | Secret key (or the legacy "service_role" key) | **Yes**, Functions scope only |

The secret key bypasses every access rule. It lives only in Netlify, never in a page, an email, or a chat.
