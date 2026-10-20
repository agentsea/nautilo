ALTER TABLE "session_messages" ALTER COLUMN "content_search" DROP EXPRESSION;--> statement-breakpoint
CREATE INDEX "idx_session_messages_search_overflow" ON "session_messages" USING btree ("session_id") WHERE "session_messages"."content_search" IS NULL AND "session_messages"."content" IS NOT NULL;
--> statement-breakpoint
-- SESSION_MESSAGE_SEARCH_OVERFLOW
CREATE FUNCTION public.refresh_session_message_search()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.content, NEW.content_search) IS NOT DISTINCT FROM ROW(OLD.content, OLD.content_search) THEN
      RETURN NEW;
    END IF;
  END IF;
  BEGIN
    NEW.content_search := to_tsvector('pg_catalog.english'::regconfig, NEW.content);
  EXCEPTION WHEN SQLSTATE '54000' THEN
    -- Do not hide other program-limit failures or abort the enclosing save.
    IF SQLERRM NOT LIKE 'string is too long for tsvector (% bytes, max % bytes)' THEN
      RAISE;
    END IF;
    NEW.content_search := NULL;
  END;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER session_message_content_search
BEFORE INSERT OR UPDATE ON public.session_messages
FOR EACH ROW EXECUTE FUNCTION public.refresh_session_message_search();
