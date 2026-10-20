"""Пароли, токени и кодове за покана. Само стандартната библиотека на Python."""
import base64
import hashlib
import hmac
import secrets
import time

SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 14, 8, 1

# букви и цифри без лесни за бъркане (0/O, 1/I/L)
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def now_ms() -> int:
    return int(time.time() * 1000)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    key = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32)
    b64 = lambda b: base64.b64encode(b).decode()
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${b64(salt)}${b64(key)}"


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        algo, n, r, p, salt, key = stored.split("$")
        if algo != "scrypt":
            return False
        got = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=32)
        return hmac.compare_digest(got, base64.b64decode(key))
    except (ValueError, TypeError):
        return False


def new_token() -> str:
    return secrets.token_urlsafe(32)


def fingerprint(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def new_invite_code() -> str:
    """Осем знака, показват се като XXXX-XXXX."""
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))


# кирилски букви, които изглеждат като латински (код, набран на българска клавиатура)
LOOKALIKE = str.maketrans("АВЕКМНОРСТХУ", "ABEKMHOPCTXY")


def normalize_code(code: str) -> str:
    return "".join(ch for ch in code.upper().translate(LOOKALIKE) if ch.isascii() and ch.isalnum())


class Throttle:
    """Ограничава опитите (вход, код за покана) по ключ: max за прозорец в секунди."""

    def __init__(self, max_attempts: int, window_s: int):
        self.max, self.window = max_attempts, window_s
        self.hits: dict[str, list[float]] = {}

    def blocked(self, key: str) -> bool:
        t = time.time()
        if len(self.hits) > 10_000:  # паметта не расте безкрайно
            self.hits = {k: v for k, v in self.hits.items() if v and t - v[-1] < self.window}
        recent = [x for x in self.hits.get(key, []) if t - x < self.window]
        self.hits[key] = recent
        return len(recent) >= self.max

    def fail(self, key: str) -> None:
        self.hits.setdefault(key, []).append(time.time())

    def reset(self, key: str) -> None:
        self.hits.pop(key, None)
