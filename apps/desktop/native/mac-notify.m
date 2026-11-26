// macOS UNUserNotificationCenter + INSendMessageIntent native bridge for LAPLACE Eidolon.
// Compiles directly with clang (-ObjC -fobjc-arc) and ABI-stable N-API extern declarations
// so apps/desktop ships zero third-party native addon packages.

#import <Foundation/Foundation.h>
#import <Intents/Intents.h>
#import <UserNotifications/UserNotifications.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_ref__* napi_ref;
typedef struct napi_handle_scope__* napi_handle_scope;
typedef struct napi_threadsafe_function__* napi_threadsafe_function;
typedef struct napi_callback_info__* napi_callback_info;

typedef enum { napi_ok = 0 } napi_status;
typedef enum {
  napi_undefined = 0,
  napi_null = 1,
  napi_boolean = 2,
  napi_number = 3,
  napi_string = 4,
  napi_symbol = 5,
  napi_object = 6,
  napi_function = 7,
} napi_valuetype;
typedef enum { napi_tsfn_nonblocking = 0, napi_tsfn_blocking = 1 } napi_threadsafe_function_call_mode;
typedef enum { napi_tsfn_release = 0, napi_tsfn_abort = 1 } napi_threadsafe_function_release_mode;

typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);
typedef void (*napi_finalize)(napi_env env, void* finalize_data, void* finalize_hint);
typedef void (*napi_threadsafe_function_call_js)(
    napi_env env, napi_value js_callback, void* context, void* data);

typedef struct {
  int nm_version;
  unsigned int nm_flags;
  const char* nm_filename;
  napi_value (*nm_register_func)(napi_env env, napi_value exports);
  const char* nm_modname;
  void* nm_priv;
  void* reserved[4];
} napi_module;

#define NAPI_AUTO_LENGTH ((size_t)-1)

extern void napi_module_register(napi_module* mod);
extern napi_status napi_throw_error(napi_env env, const char* code, const char* msg);
extern napi_status napi_get_undefined(napi_env env, napi_value* result);
extern napi_status napi_typeof(napi_env env, napi_value value, napi_valuetype* result);
extern napi_status napi_get_cb_info(
    napi_env env, napi_callback_info cbinfo, size_t* argc, napi_value* argv,
    napi_value* this_arg, void** data);
extern napi_status napi_create_string_utf8(
    napi_env env, const char* str, size_t length, napi_value* result);
extern napi_status napi_get_value_string_utf8(
    napi_env env, napi_value value, char* buf, size_t bufsize, size_t* result);
extern napi_status napi_has_named_property(
    napi_env env, napi_value object, const char* utf8name, bool* result);
extern napi_status napi_get_named_property(
    napi_env env, napi_value object, const char* utf8name, napi_value* result);
extern napi_status napi_create_function(
    napi_env env, const char* utf8name, size_t length, napi_callback cb,
    void* data, napi_value* result);
extern napi_status napi_set_named_property(
    napi_env env, napi_value object, const char* utf8name, napi_value value);
extern napi_status napi_create_threadsafe_function(
    napi_env env, napi_value func, napi_value async_resource, napi_value async_resource_name,
    size_t max_queue_size, size_t initial_thread_count, void* thread_finalize_data,
    napi_finalize thread_finalize_cb, void* context,
    napi_threadsafe_function_call_js call_js_cb, napi_threadsafe_function* result);
extern napi_status napi_unref_threadsafe_function(napi_env env, napi_threadsafe_function func);
extern napi_status napi_release_threadsafe_function(
    napi_threadsafe_function func, napi_threadsafe_function_release_mode mode);
extern napi_status napi_call_threadsafe_function(
    napi_threadsafe_function func, void* data, napi_threadsafe_function_call_mode is_blocking);
extern napi_status napi_call_function(
    napi_env env, napi_value recv, napi_value func, size_t argc,
    const napi_value* argv, napi_value* result);

typedef struct {
  char* id;
  char* error;
} NoticeEventPayload;

static napi_threadsafe_function g_click_tsfn = NULL;
static napi_threadsafe_function g_failed_tsfn = NULL;

static void dispatch_event(napi_threadsafe_function tsfn, NSString* identifier, NSString* error) {
  if (tsfn == NULL || identifier == nil) return;
  NoticeEventPayload* payload = calloc(1, sizeof(NoticeEventPayload));
  if (payload == NULL) return;
  payload->id = strdup(identifier.UTF8String);
  if (error != nil) payload->error = strdup(error.UTF8String);
  if (payload->id == NULL || (error != nil && payload->error == NULL)) {
    free(payload->id);
    free(payload->error);
    free(payload);
    return;
  }
  if (napi_call_threadsafe_function(tsfn, payload, napi_tsfn_nonblocking) != napi_ok) {
    free(payload->id);
    free(payload->error);
    free(payload);
  }
}

static void dispatch_failed(NSString* identifier, NSString* message) {
  dispatch_event(g_failed_tsfn, identifier, message ?: @"notification failed");
}

static void call_notice_js(napi_env env, napi_value js_cb, void* ctx, void* data) {
  (void)ctx;
  NoticeEventPayload* payload = (NoticeEventPayload*)data;
  if (payload == NULL) return;
  if (env != NULL && js_cb != NULL && payload->id != NULL) {
    napi_value undef = NULL;
    napi_value args[2] = {NULL, NULL};
    napi_value ignored = NULL;
    size_t argc = payload->error != NULL ? 2 : 1;
    if (napi_get_undefined(env, &undef) == napi_ok &&
        napi_create_string_utf8(env, payload->id, NAPI_AUTO_LENGTH, &args[0]) == napi_ok &&
        (argc == 1 ||
         napi_create_string_utf8(env, payload->error, NAPI_AUTO_LENGTH, &args[1]) == napi_ok)) {
      napi_call_function(env, undef, js_cb, argc, args, &ignored);
    }
  }
  free(payload->id);
  free(payload->error);
  free(payload);
}

@interface EidolonNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@property(nonatomic, weak) id<UNUserNotificationCenterDelegate> previousDelegate;
@end

@implementation EidolonNotificationDelegate

- (void)userNotificationCenter:(UNUserNotificationCenter*)center
       willPresentNotification:(UNNotification*)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
  if ([notification.request.identifier hasPrefix:@"eidolon:"]) {
    UNNotificationPresentationOptions opts =
        UNNotificationPresentationOptionBanner |
        UNNotificationPresentationOptionList |
        UNNotificationPresentationOptionSound;
    completionHandler(opts);
    return;
  }
  id<UNUserNotificationCenterDelegate> prev = self.previousDelegate;
  if (prev != nil && [prev respondsToSelector:_cmd]) {
    [prev userNotificationCenter:center
         willPresentNotification:notification
           withCompletionHandler:completionHandler];
    return;
  }
  completionHandler(UNNotificationPresentationOptionNone);
}

- (void)userNotificationCenter:(UNUserNotificationCenter*)center
    didReceiveNotificationResponse:(UNNotificationResponse*)response
             withCompletionHandler:(void (^)(void))completionHandler {
  NSString* identifier = response.notification.request.identifier;
  if ([identifier hasPrefix:@"eidolon:"]) {
    if ([response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier]) {
      dispatch_event(g_click_tsfn, identifier, nil);
    }
    completionHandler();
    return;
  }
  id<UNUserNotificationCenterDelegate> prev = self.previousDelegate;
  if (prev != nil && [prev respondsToSelector:_cmd]) {
    [prev userNotificationCenter:center
        didReceiveNotificationResponse:response
                 withCompletionHandler:completionHandler];
    return;
  }
  completionHandler();
}

@end

static EidolonNotificationDelegate* g_delegate = nil;

static NSString* read_nsstring(napi_env env, napi_value value) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return nil;
  size_t len = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &len) != napi_ok) return nil;
  char* buf = malloc(len + 1);
  if (buf == NULL) return nil;
  size_t copied = 0;
  NSString* result = nil;
  if (napi_get_value_string_utf8(env, value, buf, len + 1, &copied) == napi_ok) {
    result = [[NSString alloc] initWithBytes:buf length:copied encoding:NSUTF8StringEncoding];
  }
  free(buf);
  return result;
}

static NSString* read_prop(napi_env env, napi_value obj, const char* key) {
  bool has = false;
  if (napi_has_named_property(env, obj, key, &has) != napi_ok || !has) return nil;
  napi_value val = NULL;
  if (napi_get_named_property(env, obj, key, &val) != napi_ok || val == NULL) return nil;
  return read_nsstring(env, val);
}

static bool has_bundle_identifier(void) {
  return [[NSBundle mainBundle] bundleIdentifier].length > 0;
}

static napi_value js_init(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {NULL, NULL};
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2) {
    napi_throw_error(env, NULL, "init(onClick, onFailed) takes two callbacks");
    return NULL;
  }
  napi_valuetype click_type = napi_undefined;
  napi_valuetype failed_type = napi_undefined;
  if (napi_typeof(env, argv[0], &click_type) != napi_ok || click_type != napi_function ||
      napi_typeof(env, argv[1], &failed_type) != napi_ok || failed_type != napi_function) {
    napi_throw_error(env, NULL, "init(onClick, onFailed) requires function arguments");
    return NULL;
  }

  if (g_click_tsfn != NULL) {
    napi_release_threadsafe_function(g_click_tsfn, napi_tsfn_abort);
    g_click_tsfn = NULL;
  }
  if (g_failed_tsfn != NULL) {
    napi_release_threadsafe_function(g_failed_tsfn, napi_tsfn_abort);
    g_failed_tsfn = NULL;
  }

  napi_value click_name = NULL;
  napi_value failed_name = NULL;
  napi_create_string_utf8(env, "eidolon:mac-notify:click", NAPI_AUTO_LENGTH, &click_name);
  napi_create_string_utf8(env, "eidolon:mac-notify:failed", NAPI_AUTO_LENGTH, &failed_name);

  if (napi_create_threadsafe_function(
          env, argv[0], NULL, click_name, 0, 1, NULL, NULL, NULL, call_notice_js,
          &g_click_tsfn) != napi_ok ||
      napi_create_threadsafe_function(
          env, argv[1], NULL, failed_name, 0, 1, NULL, NULL, NULL, call_notice_js,
          &g_failed_tsfn) != napi_ok) {
    napi_throw_error(env, NULL, "couldn't create notification callbacks");
    return NULL;
  }

  // Never keep Electron/Node alive waiting on notification callbacks at quit.
  napi_unref_threadsafe_function(env, g_click_tsfn);
  napi_unref_threadsafe_function(env, g_failed_tsfn);

  if (has_bundle_identifier()) {
    @autoreleasepool {
      @try {
        UNUserNotificationCenter* center = [UNUserNotificationCenter currentNotificationCenter];
        if (g_delegate == nil) g_delegate = [[EidolonNotificationDelegate alloc] init];
        if (center.delegate != g_delegate) {
          g_delegate.previousDelegate = center.delegate;
          center.delegate = g_delegate;
        }
      } @catch (NSException* ex) {
        NSLog(@"Eidolon: failed to install notification delegate: %@", ex.reason);
      }
    }
  }

  napi_value undef = NULL;
  napi_get_undefined(env, &undef);
  return undef;
}

static napi_value js_show(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {NULL};
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_error(env, NULL, "show(options) takes an options object");
    return NULL;
  }
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_object) {
    napi_throw_error(env, NULL, "show(options) requires an object");
    return NULL;
  }

  @autoreleasepool {
    NSString* noticeId = read_prop(env, argv[0], "id");
    if (noticeId.length == 0) {
      napi_throw_error(env, NULL, "show(options) requires a non-empty id");
      return NULL;
    }
    NSString* title = read_prop(env, argv[0], "title") ?: @"";
    NSString* subtitle = read_prop(env, argv[0], "subtitle");
    NSString* body = read_prop(env, argv[0], "body") ?: @"";
    NSString* threadId = read_prop(env, argv[0], "threadId");
    NSString* senderId = read_prop(env, argv[0], "senderId");
    NSString* senderName = read_prop(env, argv[0], "senderName");
    NSString* avatarPath = read_prop(env, argv[0], "avatarPath");
    NSString* groupTitle = read_prop(env, argv[0], "groupTitle");

    if (!has_bundle_identifier()) {
      dispatch_failed(noticeId, @"application bundle has no CFBundleIdentifier");
      napi_value undef = NULL;
      napi_get_undefined(env, &undef);
      return undef;
    }

    @try {
      UNUserNotificationCenter* center = [UNUserNotificationCenter currentNotificationCenter];
      [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound)
                            completionHandler:^(BOOL granted, NSError* _Nullable authError) {
        if (!granted) {
          dispatch_failed(
              noticeId, authError ? authError.localizedDescription : @"notification permission denied");
          return;
        }
        @autoreleasepool {
          UNMutableNotificationContent* base = [[UNMutableNotificationContent alloc] init];
          base.title = title;
          if (subtitle.length > 0) base.subtitle = subtitle;
          base.body = body;
          base.sound = [UNNotificationSound defaultSound];
          if (threadId.length > 0) base.threadIdentifier = threadId;

          UNNotificationContent* finalContent = base;
          if (senderName.length > 0) {
            INImage* img = nil;
            if (avatarPath.length > 0) {
              NSData* data = [NSData dataWithContentsOfFile:avatarPath];
              if (data.length > 0) img = [INImage imageWithImageData:data];
            }
            NSString* handleVal = senderId.length > 0 ? senderId : senderName;
            INPersonHandle* handle = [[INPersonHandle alloc]
                initWithValue:handleVal
                         type:INPersonHandleTypeUnknown];
            INPerson* sender = [[INPerson alloc]
                initWithPersonHandle:handle
                      nameComponents:nil
                         displayName:senderName
                               image:img
                   contactIdentifier:nil
                    customIdentifier:(senderId.length > 0 ? senderId : nil)
                                isMe:NO
                      suggestionType:INPersonSuggestionTypeNone];

            NSString* convId = threadId.length > 0 ? threadId : handleVal;
            NSArray<INPerson*>* recipients = nil;
            INSpeakableString* group = nil;
            NSString* imageParam = @"sender";
            if (groupTitle.length > 0) {
              group = [[INSpeakableString alloc] initWithSpokenPhrase:groupTitle];
              INPersonHandle* meHandle = [[INPersonHandle alloc]
                  initWithValue:@"eidolon-viewer"
                           type:INPersonHandleTypeUnknown];
              INPerson* me = [[INPerson alloc]
                  initWithPersonHandle:meHandle
                        nameComponents:nil
                           displayName:@"Me"
                                 image:nil
                     contactIdentifier:nil
                      customIdentifier:@"eidolon-viewer"
                                  isMe:YES
                        suggestionType:INPersonSuggestionTypeNone];
              recipients = @[ me ];
              imageParam = @"speakableGroupName";
            }
            INSendMessageIntent* intent = [[INSendMessageIntent alloc]
                initWithRecipients:recipients
               outgoingMessageType:INOutgoingMessageTypeOutgoingMessageText
                           content:body
                speakableGroupName:group
            conversationIdentifier:convId
                       serviceName:nil
                            sender:sender
                       attachments:nil];
            if (img != nil) [intent setImage:img forParameterNamed:imageParam];

            INInteraction* interaction = [[INInteraction alloc] initWithIntent:intent response:nil];
            interaction.direction = INInteractionDirectionIncoming;
            [interaction donateInteractionWithCompletion:nil];

            NSError* updateError = nil;
            UNNotificationContent* updated =
                [base contentByUpdatingWithProvider:intent error:&updateError];
            // Fails gracefully when running unsigned/ad-hoc without communication entitlement.
            if (updated != nil && updateError == nil) {
              UNMutableNotificationContent* mutableUpdated = [updated mutableCopy];
              if (subtitle.length > 0 && mutableUpdated.subtitle.length == 0) {
                mutableUpdated.subtitle = subtitle;
              }
              if (threadId.length > 0 && mutableUpdated.threadIdentifier.length == 0) {
                mutableUpdated.threadIdentifier = threadId;
              }
              finalContent = mutableUpdated;
            }
          }

          UNNotificationRequest* request =
              [UNNotificationRequest requestWithIdentifier:noticeId content:finalContent trigger:nil];
          [center addNotificationRequest:request
                   withCompletionHandler:^(NSError* _Nullable addError) {
            if (addError != nil) dispatch_failed(noticeId, addError.localizedDescription);
          }];
        }
      }];
    } @catch (NSException* ex) {
      dispatch_failed(noticeId, ex.reason ?: @"notification exception");
    }
  }

  napi_value undef = NULL;
  napi_get_undefined(env, &undef);
  return undef;
}

static napi_value js_close(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {NULL};
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_error(env, NULL, "close(id) takes a notification id");
    return NULL;
  }
  @autoreleasepool {
    NSString* noticeId = read_nsstring(env, argv[0]);
    if (noticeId.length > 0 && has_bundle_identifier()) {
      @try {
        UNUserNotificationCenter* center = [UNUserNotificationCenter currentNotificationCenter];
        [center removePendingNotificationRequestsWithIdentifiers:@[ noticeId ]];
        [center removeDeliveredNotificationsWithIdentifiers:@[ noticeId ]];
      } @catch (NSException* ex) {
        NSLog(@"Eidolon: failed to close notification %@: %@", noticeId, ex.reason);
      }
    }
  }
  napi_value undef = NULL;
  napi_get_undefined(env, &undef);
  return undef;
}

static napi_value register_exports(napi_env env, napi_value exports) {
  napi_value fn_init = NULL;
  napi_value fn_show = NULL;
  napi_value fn_close = NULL;
  if (napi_create_function(env, "init", NAPI_AUTO_LENGTH, js_init, NULL, &fn_init) != napi_ok ||
      napi_create_function(env, "show", NAPI_AUTO_LENGTH, js_show, NULL, &fn_show) != napi_ok ||
      napi_create_function(env, "close", NAPI_AUTO_LENGTH, js_close, NULL, &fn_close) != napi_ok) {
    return NULL;
  }
  napi_set_named_property(env, exports, "init", fn_init);
  napi_set_named_property(env, exports, "show", fn_show);
  napi_set_named_property(env, exports, "close", fn_close);
  return exports;
}

static napi_module mac_notify_module = {
    1,
    0,
    __FILE__,
    register_exports,
    "mac_notify",
    NULL,
    {0},
};

__attribute__((constructor)) static void register_mac_notify_module(void) {
  napi_module_register(&mac_notify_module);
}
