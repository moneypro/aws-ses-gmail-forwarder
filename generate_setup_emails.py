#!/usr/bin/env python3
"""
Generates onboarding emails for tegratauto.com aliases with SMTP setup instructions.
Each email includes a derived SMTP password ready for Gmail "Send mail as" configuration.
"""

import hmac
import hashlib
import base64

# AWS SMTP password derivation (version 4, static date per AWS docs)
DATE = "11111111"
SERVICE = "ses"
MESSAGE = "SendRawEmail"
TERMINAL = "aws4_request"
VERSION = 0x04
REGION = "us-west-2"


def sign(key, msg):
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def derive_smtp_password(secret_key):
    sig = sign(("AWS4" + secret_key).encode("utf-8"), DATE)
    sig = sign(sig, REGION)
    sig = sign(sig, SERVICE)
    sig = sign(sig, TERMINAL)
    sig = sign(sig, MESSAGE)
    return base64.b64encode(bytes([VERSION]) + sig).decode("utf-8")


# Per-alias credentials — fill in key_id and secret from CDK deploy outputs
# (run: npx cdk deploy, then check stack Outputs for SmtpKeyId-* and SmtpSecretKey-*)
ALIASES = [
    {
        "name": "Cheng Hong",
        "alias": "admin",
        "email": "admin@tegratauto.com",
        "personal_email": "chenghong5451@gmail.com",
        "key_id": "REPLACE_WITH_SmtpKeyId-tegratauto-com-admin",
        "secret": "REPLACE_WITH_SmtpSecretKey-tegratauto-com-admin",
    },
    {
        "name": "Bowen",
        "alias": "bowen",
        "email": "bowen@tegratauto.com",
        "personal_email": "bowenhuang1201@gmail.com",
        "key_id": "REPLACE_WITH_SmtpKeyId-tegratauto-com-bowen",
        "secret": "REPLACE_WITH_SmtpSecretKey-tegratauto-com-bowen",
    },
    {
        "name": "Bowen Zhao",
        "alias": "bowenzhao",
        "email": "bowenzhao@tegratauto.com",
        "personal_email": "usmobowen@gmail.com",
        "key_id": "REPLACE_WITH_SmtpKeyId-tegratauto-com-bowenzhao",
        "secret": "REPLACE_WITH_SmtpSecretKey-tegratauto-com-bowenzhao",
    },
    {
        "name": "Dalin",
        "alias": "dalin",
        "email": "dalin@tegratauto.com",
        "personal_email": "dalinhenderson@yahoo.com",
        "key_id": "REPLACE_WITH_SmtpKeyId-tegratauto-com-dalin",
        "secret": "REPLACE_WITH_SmtpSecretKey-tegratauto-com-dalin",
    },
    {
        "name": "Sasha",
        "alias": "sasha",
        "email": "sasha@tegratauto.com",
        "personal_email": "sashazakhvatova@gmail.com",
        "key_id": "REPLACE_WITH_SmtpKeyId-tegratauto-com-sasha",
        "secret": "REPLACE_WITH_SmtpSecretKey-tegratauto-com-sasha",
    },
    {
        "name": "Fante",
        "alias": "fante",
        "email": "fante@tegratauto.com",
        "personal_email": "mengfante@gmail.com",
        "key_id": "REPLACE_WITH_SmtpKeyId-tegratauto-com-fante",
        "secret": "REPLACE_WITH_SmtpSecretKey-tegratauto-com-fante",
    },
    {
        "name": "Aye",
        "alias": "aye",
        "email": "aye@tegratauto.com",
        "personal_email": "aye.starr00@gmail.com",
        "key_id": "REPLACE_WITH_SmtpKeyId-tegratauto-com-aye",
        "secret": "REPLACE_WITH_SmtpSecretKey-tegratauto-com-aye",
    },
]

SMTP_SERVER = f"email-smtp.{REGION}.amazonaws.com"
SMTP_PORT = 587

EMAIL_TEMPLATE = """
To: {personal_email}
Subject: Your new tegratauto.com email address is ready

Hi {name},

Your new business email address {email} is now active. Emails sent to this address will be automatically forwarded to your personal inbox ({personal_email}).

To also SEND emails from {email} (so recipients see it as the sender), follow these steps to set up "Send mail as" in Gmail:

──────────────────────────────────────────────
STEP 1 — Open Gmail Settings
  1. Go to Gmail → click the gear icon → "See all settings"
  2. Click the "Accounts and Import" tab
  3. Under "Send mail as", click "Add another email address"

STEP 2 — Enter your address
  • Name:         Tegrata Auto  (or your preferred display name)
  • Email address: {email}
  • Uncheck "Treat as an alias" → click Next

STEP 3 — Enter SMTP credentials
  • SMTP Server:  {smtp_server}
  • Port:         {smtp_port}
  • Username:     {key_id}
  • Password:     {smtp_password}
  • Select:       TLS

  Click "Add Account"

STEP 4 — Verify
  Gmail will send a confirmation email to {email}, which will be forwarded to your inbox.
  Click the link or enter the code to complete setup.

After verification, when composing an email in Gmail you can click the "From" field to switch between your personal address and {email}.
──────────────────────────────────────────────

If you run into any issues, reach out to admin@tegratauto.com.

Best,
Tegrata Auto IT
"""


def main():
    separator = "=" * 70

    for person in ALIASES:
        smtp_password = derive_smtp_password(person["secret"])

        email_body = EMAIL_TEMPLATE.format(
            name=person["name"],
            email=person["email"],
            personal_email=person["personal_email"],
            key_id=person["key_id"],
            smtp_password=smtp_password,
            smtp_server=SMTP_SERVER,
            smtp_port=SMTP_PORT,
        )

        print(separator)
        print(f"  EMAIL FOR: {person['name']} ({person['email']})")
        print(separator)
        print(email_body)

    print(separator)


if __name__ == "__main__":
    main()
