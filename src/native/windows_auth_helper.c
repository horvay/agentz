#define UNICODE
#define _UNICODE

#include <windows.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

static wchar_t *utf8_to_wide(const char *input) {
  if (input == NULL) {
    return NULL;
  }

  int required = MultiByteToWideChar(CP_UTF8, 0, input, -1, NULL, 0);
  if (required <= 0) {
    return NULL;
  }

  wchar_t *output = (wchar_t *)calloc((size_t)required, sizeof(wchar_t));
  if (output == NULL) {
    return NULL;
  }

  if (MultiByteToWideChar(CP_UTF8, 0, input, -1, output, required) <= 0) {
    free(output);
    return NULL;
  }

  return output;
}

static char *read_password_from_stdin(void) {
  size_t capacity = 128;
  size_t length = 0;
  char *buffer = (char *)calloc(capacity, sizeof(char));
  if (buffer == NULL) {
    return NULL;
  }

  for (;;) {
    int value = fgetc(stdin);
    if (value == EOF || value == '\n' || value == '\r') {
      break;
    }

    if (length + 1 >= capacity) {
      capacity *= 2;
      char *grown = (char *)realloc(buffer, capacity);
      if (grown == NULL) {
        free(buffer);
        return NULL;
      }
      buffer = grown;
    }

    buffer[length++] = (char)value;
  }

  buffer[length] = '\0';
  return buffer;
}

static int is_invalid_login_error(DWORD error_code) {
  switch (error_code) {
    case ERROR_LOGON_FAILURE:
    case ERROR_ACCOUNT_RESTRICTION:
    case ERROR_INVALID_LOGON_HOURS:
    case ERROR_INVALID_WORKSTATION:
    case ERROR_PASSWORD_EXPIRED:
    case ERROR_ACCOUNT_DISABLED:
    case ERROR_ACCOUNT_LOCKED_OUT:
    case ERROR_NO_SUCH_USER:
      return 1;
    default:
      return 0;
  }
}

int main(int argc, char **argv) {
  if (argc < 2) {
    return 12;
  }

  char *password_utf8 = read_password_from_stdin();
  if (password_utf8 == NULL) {
    return 12;
  }

  wchar_t *username_wide = utf8_to_wide(argv[1]);
  wchar_t *password_wide = utf8_to_wide(password_utf8);
  free(password_utf8);

  if (username_wide == NULL || password_wide == NULL) {
    free(username_wide);
    free(password_wide);
    return 11;
  }

  wchar_t *domain_wide = NULL;
  wchar_t *logon_username = username_wide;
  wchar_t *backslash = wcschr(username_wide, L'\\');

  if (backslash != NULL) {
    *backslash = L'\0';
    domain_wide = username_wide;
    logon_username = backslash + 1;
  }

  HANDLE token = NULL;
  BOOL success = LogonUserW(
    logon_username,
    domain_wide != NULL ? domain_wide : L".",
    password_wide,
    LOGON32_LOGON_INTERACTIVE,
    LOGON32_PROVIDER_DEFAULT,
    &token
  );

  if (!success && domain_wide == NULL && wcschr(logon_username, L'@') != NULL) {
    success = LogonUserW(
      logon_username,
      NULL,
      password_wide,
      LOGON32_LOGON_INTERACTIVE,
      LOGON32_PROVIDER_DEFAULT,
      &token
    );
  }

  if (success) {
    if (token != NULL) {
      CloseHandle(token);
    }
    SecureZeroMemory(password_wide, (wcslen(password_wide) + 1) * sizeof(wchar_t));
    free(username_wide);
    free(password_wide);
    return 0;
  }

  DWORD error_code = GetLastError();
  SecureZeroMemory(password_wide, (wcslen(password_wide) + 1) * sizeof(wchar_t));
  free(username_wide);
  free(password_wide);

  if (is_invalid_login_error(error_code)) {
    return 10;
  }

  return 11;
}
