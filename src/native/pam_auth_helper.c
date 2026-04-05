#include <security/pam_appl.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define EXIT_AUTH_SUCCESS 0
#define EXIT_AUTH_INVALID 10
#define EXIT_AUTH_ERROR 11
#define EXIT_USAGE_ERROR 12

struct conversation_data {
  const char *password;
};

static void clear_and_free(char *value) {
  if (value == NULL) {
    return;
  }
  size_t length = strlen(value);
  memset(value, 0, length);
  free(value);
}

static int pam_conversation(
  int message_count,
  const struct pam_message **messages,
  struct pam_response **responses,
  void *appdata_ptr
) {
  if (message_count <= 0 || messages == NULL || responses == NULL || appdata_ptr == NULL) {
    return PAM_CONV_ERR;
  }

  struct conversation_data *data = (struct conversation_data *)appdata_ptr;
  struct pam_response *reply = calloc((size_t)message_count, sizeof(struct pam_response));
  if (reply == NULL) {
    return PAM_BUF_ERR;
  }

  for (int index = 0; index < message_count; index += 1) {
    const struct pam_message *message = messages[index];
    if (message == NULL) {
      free(reply);
      return PAM_CONV_ERR;
    }

    switch (message->msg_style) {
      case PAM_PROMPT_ECHO_OFF:
      case PAM_PROMPT_ECHO_ON: {
        reply[index].resp = strdup(data->password != NULL ? data->password : "");
        if (reply[index].resp == NULL) {
          for (int inner = 0; inner < index; inner += 1) {
            clear_and_free(reply[inner].resp);
          }
          free(reply);
          return PAM_BUF_ERR;
        }
        break;
      }
      case PAM_ERROR_MSG:
      case PAM_TEXT_INFO:
        reply[index].resp = NULL;
        reply[index].resp_retcode = 0;
        break;
      default:
        for (int inner = 0; inner < index; inner += 1) {
          clear_and_free(reply[inner].resp);
        }
        free(reply);
        return PAM_CONV_ERR;
    }
  }

  *responses = reply;
  return PAM_SUCCESS;
}

static char *read_password_from_stdin(void) {
  char *buffer = NULL;
  size_t capacity = 0;
  ssize_t read = getline(&buffer, &capacity, stdin);
  if (read < 0) {
    free(buffer);
    return NULL;
  }

  while (read > 0 && (buffer[read - 1] == '\n' || buffer[read - 1] == '\r')) {
    buffer[read - 1] = '\0';
    read -= 1;
  }

  return buffer;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    return EXIT_USAGE_ERROR;
  }

  const char *username = argv[1];
  const char *service = argc >= 3 ? argv[2] : "login";

  char *password = read_password_from_stdin();
  if (password == NULL) {
    return EXIT_USAGE_ERROR;
  }

  struct conversation_data data = {
    .password = password,
  };
  struct pam_conv conversation = {
    .conv = pam_conversation,
    .appdata_ptr = &data,
  };

  pam_handle_t *pam_handle = NULL;
  int rc = pam_start(service, username, &conversation, &pam_handle);
  if (rc == PAM_SUCCESS) {
    rc = pam_authenticate(pam_handle, 0);
  }
  if (rc == PAM_SUCCESS) {
    rc = pam_acct_mgmt(pam_handle, 0);
  }
  if (pam_handle != NULL) {
    pam_end(pam_handle, rc);
  }

  clear_and_free(password);

  if (rc == PAM_SUCCESS) {
    return EXIT_AUTH_SUCCESS;
  }

  if (rc == PAM_AUTH_ERR || rc == PAM_USER_UNKNOWN || rc == PAM_MAXTRIES || rc == PAM_PERM_DENIED) {
    return EXIT_AUTH_INVALID;
  }

  return EXIT_AUTH_ERROR;
}
