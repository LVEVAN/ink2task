#!/usr/bin/env python3
"""
Spike #2: prove the Supernote Cloud WRITE path end-to-end (the last unknown
before committing to the Mac app's two-way sync). Also serves as the reference
implementation for the eventual Swift client -- it documents the real login +
CSRF + upload flow reverse-engineered from the web app on 2026-07-27.

Login here is CODE-ONLY (no password) -- the same "Login with code" flow the web
app uses, which for an email account is:

  1. GET  /api/csrf                          -> XSRF-TOKEN cookie (echo as X-XSRF-TOKEN)
  2. POST /api/official/user/query/random/code {countryCode,account} -> timestamp
  3. POST /api/user/validcode/pre-auth        {account}           -> generateToken
     realKey = generateToken.split('-')[int(generateToken[-1])]
     sign    = sha256(account + realKey)
  4. POST /api/user/mail/validcode/send       {email,timestamp,token,sign}
                                              -> EMAILS the code, returns validCodeKey
  5. (you type the emailed 6-digit code)
  6. POST /api/official/user/sms/login        {email,validCode,validCodeKey,
                                               timestamp,browser,equipment:"4"} -> token

Then the WRITE round-trip (the thing we're proving):
  7. upload a tiny test file to Mystyle/Ink2Task/ via
       POST /api/file/upload/apply   (needs extra headers: timestamp,nonce,equipmentNo)
       PUT  <s3 url>
       POST /api/file/upload/finish
     ...then re-list the folder to confirm it landed, and time it.

Nothing is stored/printed except step status. The test file is named
'mac-app-roundtrip-test.json' and is safe to delete from Cloud afterward.

    export SN_EMAIL=lvevan@yahoo.com
    /tmp/sncloud-venv/bin/python mac-app/cloud-roundtrip.py
"""
import os
import sys
import json
import time
import random
from pathlib import Path
from hashlib import sha256

from sncloud import SNClient

BASE = "https://cloud.supernote.com"
BROWSER_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": BASE,
    "Referer": f"{BASE}/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
}
BROWSER_TAG = "Chrome126"
TEST_NAME = "mac-app-roundtrip-test.txt"   # .json is NOT in the upload whitelist; .txt is
TARGET_DIR = "/Mystyle/Ink2Task"   # API folder casing is 'Mystyle'


def sha256hex(s):
    return sha256(s.encode("utf-8")).hexdigest()


def nonce():
    return "".join(random.choice("0123456789") for _ in range(10)) + str(int(time.time() * 1000))


def make_client():
    """SNClient patched with the CSRF handshake + the headers newer endpoints want."""
    client = SNClient()
    http = client._client
    http.get(f"{BASE}/api/csrf", headers=BROWSER_HEADERS)
    if not http.cookies.get("XSRF-TOKEN"):
        sys.exit("Could not obtain XSRF-TOKEN from /api/csrf")

    def patched(endpoint, payload):
        headers = dict(BROWSER_HEADERS)
        headers["Content-Type"] = "application/json"
        headers["X-XSRF-TOKEN"] = http.cookies.get("XSRF-TOKEN")
        # anti-replay headers ONLY where the web app sends them (upload/apply);
        # adding them to auth endpoints can trip a WAF rule -> 403.
        if endpoint.endswith("/file/upload/apply"):
            headers["timestamp"] = str(int(time.time() * 1000))
            headers["nonce"] = nonce()
            headers["equipmentNo"] = "WEB"
        if client._access_token:
            headers["x-access-token"] = client._access_token
        r = http.post(f"{client.BASE_URL}{endpoint}", json=payload, headers=headers)
        if r.status_code >= 400:
            print(f"  !! {endpoint} -> HTTP {r.status_code}; "
                  f"server={r.headers.get('server')!r} body={r.text[:300]!r}")
            r.raise_for_status()
        return r.json()

    client._api_call = patched
    return client


def login_with_code(client, email):
    # timestamp from random/code (the value the app threads through the flow)
    rc = client._api_call("/official/user/query/random/code",
                          {"countryCode": "1", "account": email})
    if not rc.get("success"):
        sys.exit(f"random/code failed: {rc}")
    ts = rc["timestamp"]

    # pre-auth -> generateToken, then derive the signature
    pa = client._api_call("/user/validcode/pre-auth", {"account": email})
    print(f"  pre-auth -> success={pa.get('success')} errorMsg={pa.get('errorMsg')}")
    gen = pa.get("token")
    if not gen:
        sys.exit(f"pre-auth returned no token: {json.dumps(pa)[:300]}")
    idx = int(gen[-1])
    real_key = gen.split("-")[idx]
    sign = sha256hex(email + real_key)

    # send the email code
    send = client._api_call("/user/mail/validcode/send",
                            {"email": email, "timestamp": ts, "token": gen, "sign": sign})
    print(f"  mail/validcode/send -> success={send.get('success')} "
          f"errorMsg={send.get('errorMsg')} keys={sorted(send.keys())}")
    if not send.get("success"):
        sys.exit(f"send code failed: {json.dumps(send)[:300]}")
    valid_code_key = send.get("validCodeKey")

    print("\n>>> Check your email (incl. spam) for the 6-digit Supernote code. <<<")
    code = os.environ.get("SN_CODE") or input("Enter the code: ").strip()

    # The CSRF token expires quickly; the human delay above outlives it. Re-prime
    # a fresh one right before the login-completion call.
    client._client.get(f"{BASE}/api/csrf", headers=BROWSER_HEADERS)

    sms = client._api_call("/official/user/sms/login", {
        "email": email, "validCode": code, "validCodeKey": valid_code_key,
        "timestamp": ts, "browser": BROWSER_TAG, "equipment": "4",
    })
    if not sms.get("success") or not sms.get("token"):
        sys.exit(f"sms/login failed: errorMsg={sms.get('errorMsg')} "
                 f"full={json.dumps(sms)[:400]}")
    client._access_token = sms["token"]
    print("  sms/login -> token OK")
    return sms["token"]


def main():
    email = os.environ.get("SN_EMAIL") or input("Supernote email: ").strip()

    print("Requesting code + logging in (no password needed)...")
    client = make_client()
    login_with_code(client, email)
    print("Login OK.\n")

    scratch = Path(os.environ.get("TMPDIR", "/tmp"))
    fpath = scratch / TEST_NAME
    fpath.write_text(json.dumps({
        "macAppRoundtripTest": True,
        "note": "written by cloud-roundtrip.py spike; safe to delete",
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }))

    print(f"Uploading {TEST_NAME} -> {TARGET_DIR} ...")
    t0 = time.time()
    client.put(fpath, parent=TARGET_DIR)          # apply -> S3 PUT -> finish
    upload_ms = round((time.time() - t0) * 1000)

    items = client.ls(TARGET_DIR)
    names = [i.file_name for i in items]
    landed = TEST_NAME in names

    print("\n================ RESULT ================")
    print(f"  upload call time : {upload_ms} ms")
    print(f"  landed in cloud  : {'YES' if landed else 'NO'}")
    print(f"  folder now holds : {names}")
    print("========================================")
    if landed:
        print("\nWRITE PATH CONFIRMED. The Mac app can push structured state back.")
        print("Freshness check (optional): open the note on your Supernote, let it")
        print(f"sync, and see whether '{TEST_NAME}' appears on-device and how fast.")
        print("Delete the test file from Supernote Cloud (web) whenever you like.")
    else:
        print("\nUpload reported no error but file not visible yet -- paste the output.")


if __name__ == "__main__":
    main()
