
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {

  "public": {
          Tables: {
            "conversations": {
                  Row: {
                    "created_at": string,"id": string,"owner_id": string,"title": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"owner_id": string,"title": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"owner_id"?: string,"title"?: string,"updated_at"?: string
                  }
                  Relationships: [

                  ]
                },"messages": {
                  Row: {
                    "author_id": string,"client_id": string,"content": string,"conversation_id": string,"created_at": string,"id": string,"role": string
                  }
                  ComputedFields: never
                  Insert: {
                    "author_id": string,"client_id": string,"content": string,"conversation_id": string,"created_at"?: string,"id"?: string,"role": string
                  }
                  Update: {
                    "author_id"?: string,"client_id"?: string,"content"?: string,"conversation_id"?: string,"created_at"?: string,"id"?: string,"role"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "messages_conversation_id_fkey"
      columns: ["conversation_id"]
isOneToOne: false
      referencedRelation: "conversations"
      referencedColumns: ["id"]
    }
                  ]
                },"notes": {
                  Row: {
                    "body": string,"created_at": string,"id": string,"owner_id": string,"title": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "body"?: string,"created_at"?: string,"id"?: string,"owner_id": string,"title": string,"updated_at"?: string
                  }
                  Update: {
                    "body"?: string,"created_at"?: string,"id"?: string,"owner_id"?: string,"title"?: string,"updated_at"?: string
                  }
                  Relationships: [

                  ]
                },"profiles": {
                  Row: {
                    "created_at": string,"display_name": string,"id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"display_name"?: string,"id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"display_name"?: string,"id"?: string,"updated_at"?: string
                  }
                  Relationships: [

                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "admit_chat_generation":
{ Args: { "p_client_id": string,"p_content": string,"p_conversation_id": string,"p_request_fingerprint": string,"p_user_message_id": string }; Returns: {
              "assistant_message_id": string,"attempt": number,"outcome": string
            }[]
                           },
"admit_encode_job":
{ Args: { "p_fingerprint": string,"p_fixture": string,"p_idempotency_key": string,"p_job_id": string,"p_preset": string,"p_workflow_id": string }; Returns: {
              "job_id": string,"outcome": string
            }[]
                           },
"authorize_job_runner":
{ Args: { "p_attempt_id": string,"p_execution_name": string,"p_job_id": string }; Returns: {
              "attempt_id": string,"expires_at": string,"fixture": string,"job_id": string,"output_key": string,"preset": string
            }[]
                           },
"begin_maintenance_run":
{ Args: { "p_run_key": string,"p_scheduled_time"?: string,"p_slot"?: string,"p_trigger": string }; Returns: boolean
                           },
"claim_encode_job":
{ Args: { "p_attempt_id": string,"p_job_id": string,"p_lease_seconds"?: number }; Returns: boolean
                           },
"cloud_run_attempt_failure":
{ Args: { "p_attempt_id": string,"p_job_id": string }; Returns: {
              "error_code": string,"job_status": string
            }[]
                           },
"complete_chat_generation":
{ Args: { "p_attempt": number,"p_client_id": string,"p_content": string,"p_conversation_id": string }; Returns: string
                           },
"fail_chat_generation":
{ Args: { "p_attempt": number,"p_client_id": string,"p_conversation_id": string,"p_state": string }; Returns: boolean
                           },
"fail_encode_job":
{ Args: { "p_attempt_id": string,"p_error_code": string,"p_job_id": string,"p_retryable": boolean }; Returns: boolean
                           },
"finish_encode_job":
{ Args: { "p_attempt_id": string,"p_codec": string,"p_duration_ms": number,"p_format": string,"p_height": number,"p_job_id": string,"p_output_bytes": number,"p_output_key": string,"p_sha256": string,"p_width": number }; Returns: boolean
                           },
"finish_maintenance_run":
{ Args: { "p_artifacts_queued"?: number,"p_artifacts_retired"?: number,"p_error_code"?: string,"p_run_key": string,"p_status": string }; Returns: boolean
                           },
"get_encode_job":
{ Args: { "p_job_id": string }; Returns: Json
                           },
"get_encode_job_output":
{ Args: { "p_job_id": string }; Returns: {
              "expires_at": string,"output_key": string
            }[]
                           },
"get_latest_maintenance":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"list_encode_jobs":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"prune_maintenance_history":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"queue_expired_job_artifacts":
{ Args: { "p_cutoff": string,"p_limit"?: number }; Returns: {
              "job_id": string,"output_key": string
            }[]
                           },
"readiness_probe":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"record_cloud_run_execution":
{ Args: { "p_attempt_id": string,"p_execution_name": string,"p_job_id": string }; Returns: boolean
                           },
"record_job_dispatch":
{ Args: { "p_dispatch_state": string,"p_error_code"?: string,"p_job_id": string }; Returns: boolean
                           },
"retire_job_artifact":
{ Args: { "p_job_id": string,"p_output_key": string }; Returns: boolean
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {

          }
        }
} as const
