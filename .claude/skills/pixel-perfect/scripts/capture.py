#!/usr/bin/env python3
"""
Playwright screenshot capture for the pixel-perfect skill (generic: any project).

Auth options:
  --cdp-url              Your real browser (session already there).
  --auth-token + --auth-token-url   Session injection URL with {token}.
  --login-form / --login-api-url   Up-front automated login.

If you did not configure login and the target URL redirects (e.g. to / or /login),
the script asks for credentials on a TTY and retries (see capture.md).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from getpass import getpass
from urllib.parse import quote, urlparse

ENV_USER = "PIXEL_PERFECT_AUTH_USER"
ENV_PASSWORD = "PIXEL_PERFECT_AUTH_PASSWORD"
ENV_USER_ALT = "PIXEL_PERFECT_LOGIN_EMAIL"
ENV_PASSWORD_ALT = "PIXEL_PERFECT_LOGIN_PASSWORD"

ENV_LOGIN_PAGE = "PIXEL_PERFECT_LOGIN_PAGE"
ENV_SEL_USER = "PIXEL_PERFECT_LOGIN_USER_SELECTOR"
ENV_SEL_PASSWORD = "PIXEL_PERFECT_LOGIN_PASSWORD_SELECTOR"
ENV_SEL_SUBMIT = "PIXEL_PERFECT_LOGIN_SUBMIT_SELECTOR"
ENV_LOGIN_POST_WAIT = "PIXEL_PERFECT_LOGIN_POST_SUBMIT_WAIT_FOR"

ENV_LOGIN_API_URL = "PIXEL_PERFECT_LOGIN_API_URL"
ENV_API_USER_KEY = "PIXEL_PERFECT_LOGIN_API_USER_KEY"
ENV_API_PASSWORD_KEY = "PIXEL_PERFECT_LOGIN_API_PASSWORD_KEY"


def parse_viewport(s: str) -> tuple[int, int]:
    parts = s.lower().replace("x", "x").split("x")
    if len(parts) != 2:
        raise ValueError(f"Viewport must be WxH, got: {s!r}")
    return int(parts[0]), int(parts[1])


def normalize_path(path: str) -> str:
    if not path:
        return "/"
    if len(path) > 1 and path.endswith("/"):
        return path.rstrip("/")
    return path


def path_matches_target(actual_url: str, target_url: str) -> tuple[bool, str]:
    ap = normalize_path(urlparse(actual_url).path)
    tp = normalize_path(urlparse(target_url).path)
    if ap == tp:
        return True, ""
    if ap.startswith(tp + "/") or tp.startswith(ap + "/"):
        return True, ""
    if ap == "/" and tp != "/":
        return False, "landed on site home (session missing or wrong redirect?)"
    return False, f"expected path {tp!r}, got {ap!r}"


def should_offer_login_prompt(actual_url: str, target_url: str, path_ok: bool) -> bool:
    """Heuristic: we wanted a non-trivial path but landed elsewhere → likely need login."""
    if path_ok:
        return False
    ap = normalize_path(urlparse(actual_url).path)
    tp = normalize_path(urlparse(target_url).path)
    if tp == "/":
        return False
    if ap == tp:
        return False
    login_paths = (
        "/",
        "/login",
        "/signin",
        "/sign-in",
        "/hub/auth",
        "/auth",
        "/session",
    )
    if ap in login_paths:
        return True
    if "login" in ap.lower():
        return True
    return False


def resolve_credentials(args: argparse.Namespace) -> tuple[str | None, str | None]:
    user = (
        args.login_user
        or os.environ.get(ENV_USER, "").strip()
        or os.environ.get(ENV_USER_ALT, "").strip()
        or None
    )
    password = (
        args.login_password
        or os.environ.get(ENV_PASSWORD, "")
        or os.environ.get(ENV_PASSWORD_ALT, "")
        or None
    )
    if password == "":
        password = None

    want = (
        args.login
        or args.interactive_login
        or args.login_form
        or args.login_user
        or args.login_password
        or bool(args.login_api_url)
        or bool(os.environ.get(ENV_LOGIN_API_URL))
        or (
            (os.environ.get(ENV_USER) or os.environ.get(ENV_USER_ALT))
            and (os.environ.get(ENV_PASSWORD) or os.environ.get(ENV_PASSWORD_ALT))
        )
    )

    if not want and not args.interactive_login:
        return None, None

    if args.interactive_login or (want and (not user or not password)):
        if not sys.stdin.isatty():
            print(
                "ERROR: credentials missing and stdin is not a TTY. Set "
                f"{ENV_USER} and {ENV_PASSWORD}, or pass --login-user / --login-password.",
                file=sys.stderr,
            )
            sys.exit(1)
        if not user:
            user = input("Username or email: ").strip()
        if not password:
            password = getpass("Password: ")

    if not user or not password:
        return None, None
    return user, password


def absolutize_url(base: str, path_or_url: str) -> str:
    if path_or_url.startswith("http://") or path_or_url.startswith("https://"):
        return path_or_url
    p = path_or_url if path_or_url.startswith("/") else "/" + path_or_url
    return base.rstrip("/") + p


def login_via_form(
    page,
    base: str,
    login_page: str,
    username: str,
    password: str,
    sel_user: str,
    sel_password: str,
    sel_submit: str,
    post_submit_wait_for: str | None,
    PWTimeout,
) -> None:
    url = absolutize_url(base, login_page)
    print(f"Opening login page {url} …")
    try:
        page.goto(url, wait_until="networkidle", timeout=45_000)
    except PWTimeout:
        page.goto(url, wait_until="load", timeout=45_000)

    print("Filling login form …")
    page.wait_for_selector(sel_user, state="visible", timeout=15_000)
    page.fill(sel_user, username)
    page.fill(sel_password, password)
    page.click(sel_submit)

    try:
        page.wait_for_load_state("networkidle", timeout=30_000)
    except PWTimeout:
        page.wait_for_load_state("load", timeout=15_000)

    if post_submit_wait_for:
        print(f"Waiting after submit: {post_submit_wait_for}")
        try:
            page.wait_for_selector(post_submit_wait_for, timeout=20_000)
        except PWTimeout:
            print(
                f"WARNING: post-submit selector {post_submit_wait_for!r} not found",
                file=sys.stderr,
            )

    print("Form login flow finished.")


def login_via_api(
    context,
    api_url: str,
    username: str,
    password: str,
    user_key: str,
    password_key: str,
    expect_success_field: bool,
) -> bool:
    print(f"POST {api_url} …")
    body = {user_key: username, password_key: password}
    resp = context.request.post(
        api_url,
        data=json.dumps(body),
        headers={"Content-Type": "application/json"},
    )
    if resp.status < 200 or resp.status >= 300:
        print(f"ERROR: login HTTP {resp.status}: {resp.text()[:800]}", file=sys.stderr)
        return False
    try:
        data = resp.json()
    except Exception:
        print("Login OK (non-JSON response, cookies may still be set).")
        return True
    if expect_success_field and data is not None and isinstance(data, dict):
        if data.get("success") is False:
            print(f"ERROR: login failed: {data}", file=sys.stderr)
            return False
    print("API login OK (session cookie should be set).")
    return True


def prompt_login_after_redirect(
    base: str,
    page,
    context,
    args: argparse.Namespace,
    login_page: str | None,
    sel_u: str | None,
    sel_p: str | None,
    sel_s: str | None,
    post_wait: str | None,
    PWTimeout,
) -> bool:
    """
    Ask for credentials in the terminal and perform API or form login.
    Returns True if login succeeded (caller should re-navigate to target).
    """
    print(
        "\n── Pixel-perfect capture ─────────────────────────────────────\n"
        "This page probably needs authentication (redirected away from the target).\n"
        "Enter credentials to continue (or Ctrl+C to abort).\n"
        "──────────────────────────────────────────────────────────────\n",
        file=sys.stderr,
    )
    user = input("Username or email: ").strip()
    password = getpass("Password: ")

    form_ready = bool(login_page and sel_u and sel_p and sel_s)
    api_path = args.login_api_url or os.environ.get(ENV_LOGIN_API_URL)

    if form_ready:
        use_form = True
        if sys.stdin.isatty():
            choice = input("Use [f]orm on login page or [a]PI POST? [f/a] ").strip().lower()
            if choice == "a":
                use_form = False
    else:
        use_form = False

    if use_form:
        login_via_form(
            page,
            base,
            login_page,
            user,
            password,
            sel_u,
            sel_p,
            sel_s,
            post_wait,
            PWTimeout,
        )
        return True

    default_api = api_path or "/api/auth/login"
    if sys.stdin.isatty():
        typed = input(f"API login path (relative to origin) [{default_api}]: ").strip()
        api_path = typed or default_api
    else:
        api_path = default_api

    api_abs = absolutize_url(base, api_path)
    uk = (
        os.environ.get(ENV_API_USER_KEY)
        or args.login_api_user_key
    )
    pk = (
        os.environ.get(ENV_API_PASSWORD_KEY)
        or args.login_api_password_key
    )
    if sys.stdin.isatty() and not os.environ.get(ENV_API_USER_KEY):
        uk_in = input(f"JSON field name for user [{uk}]: ").strip()
        if uk_in:
            uk = uk_in
        pk_in = input(f"JSON field name for password [{pk}]: ").strip()
        if pk_in:
            pk = pk_in

    return login_via_api(
        context,
        api_abs,
        user,
        password,
        uk,
        pk,
        expect_success_field=not args.login_api_no_success_field,
    )


def navigate_to_target(page, target_url: str, PWTimeout) -> None:
    print(f"Navigating to target: {target_url} …")
    try:
        page.goto(target_url, wait_until="networkidle", timeout=45_000)
    except PWTimeout:
        page.goto(target_url, wait_until="load", timeout=45_000)


def main() -> None:
    p = argparse.ArgumentParser(
        description="Capture a screenshot for pixel-perfect comparison (generic; configure auth per project)."
    )
    p.add_argument("--url", required=True, help="Final page to screenshot (absolute URL).")
    p.add_argument("--output", required=True)
    p.add_argument("--viewport", default="1440x900")
    p.add_argument("--full-page", action="store_true")
    p.add_argument("--selector", default=None)
    p.add_argument("--wait-for", default=None)
    p.add_argument("--delay", type=int, default=300)
    p.add_argument("--cdp-url", default=None, metavar="URL")
    p.add_argument("--cdp-use-first-tab", action="store_true")
    p.add_argument("--device-scale-factor", type=float, default=2.0)
    p.add_argument("--auth-token", default=None)
    p.add_argument("--auth-token-file", default=None)
    p.add_argument(
        "--auth-token-url",
        default=None,
        metavar="TEMPLATE",
        help="Required with --auth-token: URL containing {token}.",
    )
    p.add_argument("--login", action="store_true")
    p.add_argument("--interactive-login", action="store_true")
    p.add_argument("--login-user", default=None)
    p.add_argument("--login-password", default=None)
    p.add_argument("--login-form", action="store_true")
    p.add_argument("--login-page", default=None)
    p.add_argument("--login-user-selector", default=None)
    p.add_argument("--login-password-selector", default=None)
    p.add_argument("--login-submit-selector", default=None)
    p.add_argument("--login-post-submit-wait-for", default=None)
    p.add_argument("--login-api-url", default=None)
    p.add_argument("--login-api-user-key", default="email")
    p.add_argument("--login-api-password-key", default="password")
    p.add_argument(
        "--login-api-no-success-field",
        action="store_true",
    )
    p.add_argument("--skip-sanity-check", action="store_true")
    p.add_argument(
        "--no-login-prompt",
        action="store_true",
        help="Do not prompt for credentials when the first navigation fails (for CI).",
    )
    args = p.parse_args()

    auth_token = args.auth_token
    if args.auth_token_file:
        try:
            with open(args.auth_token_file, encoding="utf-8") as f:
                auth_token = f.read().strip()
        except OSError as e:
            print(f"ERROR: cannot read --auth-token-file: {e}", file=sys.stderr)
            sys.exit(1)

    auth_token_url = args.auth_token_url or os.environ.get("PIXEL_PERFECT_AUTH_TOKEN_URL")

    if args.cdp_url and (auth_token or args.auth_token_file):
        print("ERROR: use either --cdp-url or --auth-token, not both.", file=sys.stderr)
        sys.exit(1)

    user_pw = resolve_credentials(args)
    if auth_token and user_pw[0]:
        print("ERROR: use either --auth-token or password login, not both.", file=sys.stderr)
        sys.exit(1)

    login_page = args.login_page or os.environ.get(ENV_LOGIN_PAGE)
    sel_u = args.login_user_selector or os.environ.get(ENV_SEL_USER)
    sel_p = args.login_password_selector or os.environ.get(ENV_SEL_PASSWORD)
    sel_s = args.login_submit_selector or os.environ.get(ENV_SEL_SUBMIT)
    post_wait = args.login_post_submit_wait_for or os.environ.get(ENV_LOGIN_POST_WAIT)

    api_url = args.login_api_url or os.environ.get(ENV_LOGIN_API_URL)

    use_form = args.login_form or (
        login_page
        and sel_u
        and sel_p
        and sel_s
        and user_pw[0]
        and user_pw[1]
    )
    use_api = bool(api_url) and bool(user_pw[0]) and bool(user_pw[1])

    if use_form and use_api:
        print("ERROR: choose either form login or --login-api-url, not both.", file=sys.stderr)
        sys.exit(1)

    try:
        from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
    except ImportError:
        print(
            "ERROR: pip install playwright && python -m playwright install chromium",
            file=sys.stderr,
        )
        sys.exit(1)

    origin = urlparse(args.url)
    if not origin.scheme or not origin.netloc:
        print("ERROR: --url must be absolute.", file=sys.stderr)
        sys.exit(1)
    base = f"{origin.scheme}://{origin.netloc}"

    width, height = parse_viewport(args.viewport)

    with sync_playwright() as pw:
        if args.cdp_url:
            print(f"Connecting via CDP: {args.cdp_url} …")
            browser = pw.chromium.connect_over_cdp(args.cdp_url)
            contexts = browser.contexts
            if not contexts:
                print("ERROR: no browser contexts.", file=sys.stderr)
                sys.exit(1)
            context = contexts[0]
            page = context.pages[0] if args.cdp_use_first_tab and context.pages else context.new_page()
            try:
                page.set_viewport_size({"width": width, "height": height})
            except Exception as e:
                print(f"WARNING: viewport: {e}", file=sys.stderr)
        else:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": width, "height": height},
                device_scale_factor=args.device_scale_factor,
            )
            page = context.new_page()

        upfront_auth = bool(auth_token) or use_form or use_api

        if auth_token:
            if not auth_token_url:
                print(
                    "ERROR: with --auth-token, set --auth-token-url or PIXEL_PERFECT_AUTH_TOKEN_URL.",
                    file=sys.stderr,
                )
                sys.exit(1)
            inject = auth_token_url.replace("{token}", quote(auth_token, safe=""))
            print(f"Session injection: {inject[:88]}…")
            try:
                page.goto(inject, wait_until="networkidle", timeout=30_000)
            except PWTimeout:
                page.goto(inject, wait_until="load", timeout=30_000)

        elif use_form:
            if not user_pw[0] or not user_pw[1]:
                print("ERROR: form login needs credentials.", file=sys.stderr)
                sys.exit(1)
            if not (login_page and sel_u and sel_p and sel_s):
                print("ERROR: form login needs page URL and three selectors (or env).", file=sys.stderr)
                sys.exit(1)
            login_via_form(
                page,
                base,
                login_page,
                user_pw[0],
                user_pw[1],
                sel_u,
                sel_p,
                sel_s,
                post_wait,
                PWTimeout,
            )

        elif use_api:
            if not user_pw[0] or not user_pw[1]:
                print("ERROR: API login needs credentials.", file=sys.stderr)
                sys.exit(1)
            api_abs = absolutize_url(base, api_url)
            if not login_via_api(
                context,
                api_abs,
                user_pw[0],
                user_pw[1],
                args.login_api_user_key,
                args.login_api_password_key,
                expect_success_field=not args.login_api_no_success_field,
            ):
                sys.exit(1)

        elif user_pw[0] and (args.login or args.interactive_login):
            print(
                "ERROR: credentials set but no login method. Use --login-form, --login-api-url, "
                "token+URL, or --cdp-url.",
                file=sys.stderr,
            )
            sys.exit(1)

        navigate_to_target(page, args.url, PWTimeout)

        path_ok, reason = path_matches_target(page.url, args.url)

        if (
            not path_ok
            and not args.skip_sanity_check
            and not args.cdp_url
            and not upfront_auth
            and should_offer_login_prompt(page.url, args.url, path_ok)
            and sys.stdin.isatty()
            and not args.no_login_prompt
        ):
            if prompt_login_after_redirect(
                base,
                page,
                context,
                args,
                login_page,
                sel_u,
                sel_p,
                sel_s,
                post_wait,
                PWTimeout,
            ):
                navigate_to_target(page, args.url, PWTimeout)
                path_ok, reason = path_matches_target(page.url, args.url)

        if not args.skip_sanity_check and not args.cdp_url:
            if not path_ok:
                print(
                    f"\nERROR: sanity check failed — {reason}\n"
                    f"  Final URL: {page.url}\n"
                    f"  Target:    {args.url}\n",
                    file=sys.stderr,
                )
                if not sys.stdin.isatty():
                    print(
                        f"  (stdin is not a TTY — set {ENV_USER}/{ENV_PASSWORD} or use --login-api-url.)",
                        file=sys.stderr,
                    )
                else:
                    print(
                        "  Tip: run again without --no-login-prompt to enter credentials when redirected.",
                        file=sys.stderr,
                    )
                sys.exit(1)
            print(f"Sanity OK: {page.url}")

        if args.wait_for:
            try:
                page.wait_for_selector(args.wait_for, timeout=15_000)
            except PWTimeout:
                print(f"WARNING: --wait-for {args.wait_for!r} not found", file=sys.stderr)

        if args.delay:
            page.wait_for_timeout(args.delay)

        if args.selector:
            el = page.query_selector(args.selector)
            if el is None:
                print(f"ERROR: --selector {args.selector!r} not found", file=sys.stderr)
                sys.exit(1)
            el.screenshot(path=args.output)
            print(f"Element screenshot saved → {args.output}")
        else:
            page.screenshot(path=args.output, full_page=args.full_page)
            print(f"Page screenshot saved → {args.output}")

        browser.close()


if __name__ == "__main__":
    main()
